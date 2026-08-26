/*
  SQLite flight recorder — the zero-config default. WAL mode so a live
  `whale run` (single writer) coexists with dashboard/MCP readers. Hot
  columns are real columns for indexed queries; the full payloads live as
  JSON so the schema never lags the types.
*/

import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { type AlertRule, alertRuleSchema } from "../config.js";
import { type BaselineDayRows, BaselineState } from "../score/baselines.js";
import type {
  ChainSnapshot,
  EngineStats,
  FiredAlert,
  FlowEvent,
  OptionTradeTick,
} from "../types.js";
import { sessionDateOf } from "../util/session.js";
import type {
  ContractDailyRow,
  EventFilter,
  FlightRecorder,
  NetFlowRow,
  ShortVolumeRow,
  StoredRule,
  StoreStatus,
  TickFilter,
  UnderlyingDailyRow,
} from "./types.js";

// v2 added contract_daily / underlying_daily / short_volume_daily — purely
// additive, so older databases upgrade transparently on open.
const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticks_raw (
  seq INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  contract TEXT NOT NULL,
  underlying TEXT NOT NULL,
  session_date TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticks_ts ON ticks_raw (ts);
CREATE INDEX IF NOT EXISTS idx_ticks_contract_ts ON ticks_raw (contract, ts);
CREATE INDEX IF NOT EXISTS idx_ticks_underlying_ts ON ticks_raw (underlying, ts);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  session_date TEXT NOT NULL,
  underlying TEXT NOT NULL,
  contract TEXT NOT NULL,
  kind TEXT NOT NULL,
  side TEXT NOT NULL,
  premium REAL NOT NULL,
  score REAL NOT NULL,
  cold_start INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
CREATE INDEX IF NOT EXISTS idx_events_underlying_ts ON events (underlying, ts);
CREATE INDEX IF NOT EXISTS idx_events_score ON events (score DESC, ts DESC);
CREATE TABLE IF NOT EXISTS baseline_contract_daily (
  contract TEXT NOT NULL,
  session_date TEXT NOT NULL,
  volume INTEGER NOT NULL,
  trade_count INTEGER NOT NULL,
  PRIMARY KEY (contract, session_date)
);
CREATE TABLE IF NOT EXISTS baseline_underlying_premium (
  underlying TEXT NOT NULL,
  session_date TEXT NOT NULL,
  histogram TEXT NOT NULL,
  PRIMARY KEY (underlying, session_date)
);
CREATE TABLE IF NOT EXISTS baseline_bucket_size (
  bucket TEXT NOT NULL,
  session_date TEXT NOT NULL,
  histogram TEXT NOT NULL,
  PRIMARY KEY (bucket, session_date)
);
CREATE TABLE IF NOT EXISTS chain_snapshots (
  underlying TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contract_daily (
  contract TEXT NOT NULL,
  session_date TEXT NOT NULL,
  underlying TEXT NOT NULL,
  expiry TEXT NOT NULL,
  strike REAL NOT NULL,
  right TEXT NOT NULL,
  oi INTEGER,
  iv REAL,
  mid REAL,
  volume INTEGER,
  PRIMARY KEY (contract, session_date)
);
CREATE INDEX IF NOT EXISTS idx_contract_daily_underlying
  ON contract_daily (underlying, session_date);
CREATE TABLE IF NOT EXISTS underlying_daily (
  underlying TEXT NOT NULL,
  session_date TEXT NOT NULL,
  spot_close REAL,
  atm_iv REAL,
  PRIMARY KEY (underlying, session_date)
);
CREATE TABLE IF NOT EXISTS short_volume_daily (
  symbol TEXT NOT NULL,
  session_date TEXT NOT NULL,
  short_volume INTEGER NOT NULL,
  short_exempt_volume INTEGER NOT NULL,
  total_volume INTEGER NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (symbol, session_date)
);
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  json TEXT NOT NULL,
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts_fired (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  sink TEXT NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts_fired (ts DESC);
`;

export class SqliteFlightRecorder implements FlightRecorder {
  private db: Database.Database;

  constructor(
    readonly path: string,
    options: { readonly?: boolean } = {},
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { readonly: options.readonly ?? false });
    if (!options.readonly) {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.db.exec(SCHEMA);
      this.db
        .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)")
        .run(String(SCHEMA_VERSION));
    }
  }

  insertTicks(ticks: OptionTradeTick[]): void {
    if (ticks.length === 0) return;
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO ticks_raw (seq, ts, contract, underlying, session_date, json) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const tx = this.db.transaction((rows: OptionTradeTick[]) => {
      for (const t of rows) {
        stmt.run(t.seq, t.ts, t.contract, t.underlying, sessionDateOf(t.ts), JSON.stringify(t));
      }
    });
    tx(ticks);
  }

  insertEvents(events: FlowEvent[]): void {
    if (events.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO events
       (id, ts, seq, session_date, underlying, contract, kind, side, premium, score, cold_start, json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((rows: FlowEvent[]) => {
      for (const e of rows) {
        stmt.run(
          e.id,
          e.ts,
          e.seq,
          e.sessionDate,
          e.underlying,
          e.contract,
          e.kind,
          e.side,
          e.premium,
          e.score.total,
          e.score.coldStart ? 1 : 0,
          JSON.stringify(e),
        );
      }
    });
    tx(events);
  }

  getEvent(id: string): FlowEvent | null {
    const row = this.db.prepare("SELECT json FROM events WHERE id = ?").get(id) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as FlowEvent) : null;
  }

  queryEvents(filter: EventFilter): FlowEvent[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.underlying) {
      where.push("underlying = ?");
      params.push(filter.underlying.toUpperCase());
    }
    if (filter.contract) {
      where.push("contract = ?");
      params.push(filter.contract.toUpperCase());
    }
    if (filter.kind) {
      where.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.side) {
      where.push("side = ?");
      params.push(filter.side);
    }
    if (filter.minPremium !== undefined) {
      where.push("premium >= ?");
      params.push(filter.minPremium);
    }
    if (filter.minScore !== undefined) {
      where.push("score >= ?");
      params.push(filter.minScore);
    }
    if (filter.excludeColdStart) where.push("cold_start = 0");
    if (filter.from !== undefined) {
      where.push("ts >= ?");
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      where.push("ts <= ?");
      params.push(filter.to);
    }
    const order = filter.orderBy === "score" ? "score DESC, ts DESC" : "ts DESC, seq DESC";
    const sql = `SELECT json FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT ?`;
    params.push(Math.min(filter.limit ?? 100, 1000));
    const rows = this.db.prepare(sql).all(...params) as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as FlowEvent);
  }

  *iterateTicks(filter: TickFilter): Iterable<OptionTradeTick> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.from !== undefined) {
      where.push("ts >= ?");
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      where.push("ts <= ?");
      params.push(filter.to);
    }
    if (filter.underlying) {
      where.push("underlying = ?");
      params.push(filter.underlying.toUpperCase());
    }
    if (filter.contract) {
      where.push("contract = ?");
      params.push(filter.contract.toUpperCase());
    }
    const sql = `SELECT json FROM ticks_raw ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq ASC`;
    for (const row of this.db.prepare(sql).iterate(...params) as IterableIterator<{
      json: string;
    }>) {
      yield JSON.parse(row.json) as OptionTradeTick;
    }
  }

  countTicks(filter: TickFilter): number {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.from !== undefined) {
      where.push("ts >= ?");
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      where.push("ts <= ?");
      params.push(filter.to);
    }
    if (filter.underlying) {
      where.push("underlying = ?");
      params.push(filter.underlying.toUpperCase());
    }
    if (filter.contract) {
      where.push("contract = ?");
      params.push(filter.contract.toUpperCase());
    }
    const sql = `SELECT COUNT(*) AS n FROM ticks_raw ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
    const row = this.db.prepare(sql).get(...params) as { n: number };
    return row.n;
  }

  maxTickSeq(): number | null {
    const row = this.db.prepare("SELECT MAX(seq) AS s FROM ticks_raw").get() as {
      s: number | null;
    };
    return row.s;
  }

  saveBaselineDay(rows: BaselineDayRows): void {
    const contractStmt = this.db.prepare(
      "INSERT OR REPLACE INTO baseline_contract_daily (contract, session_date, volume, trade_count) VALUES (?, ?, ?, ?)",
    );
    const premiumStmt = this.db.prepare(
      "INSERT OR REPLACE INTO baseline_underlying_premium (underlying, session_date, histogram) VALUES (?, ?, ?)",
    );
    const sizeStmt = this.db.prepare(
      "INSERT OR REPLACE INTO baseline_bucket_size (bucket, session_date, histogram) VALUES (?, ?, ?)",
    );
    const tx = this.db.transaction((r: BaselineDayRows) => {
      for (const c of r.contracts)
        contractStmt.run(c.contract, r.sessionDate, c.volume, c.tradeCount);
      for (const u of r.underlyingPremium)
        premiumStmt.run(u.underlying, r.sessionDate, JSON.stringify(u.histogram));
      for (const b of r.bucketSize)
        sizeStmt.run(b.bucket, r.sessionDate, JSON.stringify(b.histogram));
    });
    tx(rows);
  }

  baselineSessionDates(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT session_date AS d FROM (
           SELECT session_date FROM baseline_contract_daily
           UNION SELECT session_date FROM baseline_underlying_premium
           UNION SELECT session_date FROM baseline_bucket_size
         ) ORDER BY d ASC`,
      )
      .all() as Array<{ d: string }>;
    return rows.map((r) => r.d);
  }

  loadBaselineState(lookbackDays: number, beforeDate?: string): BaselineState {
    const state = BaselineState.empty(lookbackDays);
    const dates = this.baselineSessionDates()
      .filter((d) => !beforeDate || d < beforeDate)
      .slice(-lookbackDays);
    const contractStmt = this.db.prepare(
      "SELECT contract, volume, trade_count FROM baseline_contract_daily WHERE session_date = ?",
    );
    const premiumStmt = this.db.prepare(
      "SELECT underlying, histogram FROM baseline_underlying_premium WHERE session_date = ?",
    );
    const sizeStmt = this.db.prepare(
      "SELECT bucket, histogram FROM baseline_bucket_size WHERE session_date = ?",
    );
    for (const date of dates) {
      const contracts = (
        contractStmt.all(date) as Array<{ contract: string; volume: number; trade_count: number }>
      ).map((r) => ({ contract: r.contract, volume: r.volume, tradeCount: r.trade_count }));
      const underlyingPremium = (
        premiumStmt.all(date) as Array<{ underlying: string; histogram: string }>
      ).map((r) => ({ underlying: r.underlying, histogram: JSON.parse(r.histogram) }));
      const bucketSize = (sizeStmt.all(date) as Array<{ bucket: string; histogram: string }>).map(
        (r) => ({
          bucket: r.bucket as BaselineDayRows["bucketSize"][number]["bucket"],
          histogram: JSON.parse(r.histogram),
        }),
      );
      state.loadDay({ sessionDate: date, contracts, underlyingPremium, bucketSize });
    }
    return state;
  }

  upsertChainSnapshot(snapshot: ChainSnapshot): void {
    this.db
      .prepare("INSERT OR REPLACE INTO chain_snapshots (underlying, ts, json) VALUES (?, ?, ?)")
      .run(snapshot.underlying.toUpperCase(), snapshot.ts, JSON.stringify(snapshot));
  }

  getChainSnapshot(underlying: string): ChainSnapshot | null {
    const row = this.db
      .prepare("SELECT json FROM chain_snapshots WHERE underlying = ?")
      .get(underlying.toUpperCase()) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as ChainSnapshot) : null;
  }

  listChainSnapshots(): Array<{ underlying: string; ts: number }> {
    return this.db
      .prepare("SELECT underlying, ts FROM chain_snapshots ORDER BY underlying ASC")
      .all() as Array<{ underlying: string; ts: number }>;
  }

  upsertContractDaily(rows: ContractDailyRow[]): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO contract_daily
       (contract, session_date, underlying, expiry, strike, right, oi, iv, mid, volume)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((all: ContractDailyRow[]) => {
      for (const r of all) {
        stmt.run(
          r.contract,
          r.sessionDate,
          r.underlying.toUpperCase(),
          r.expiry,
          r.strike,
          r.right,
          r.oi,
          r.iv,
          r.mid,
          r.volume,
        );
      }
    });
    tx(rows);
  }

  getContractDaily(contract: string, days = 30): ContractDailyRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM contract_daily WHERE contract = ?
         ORDER BY session_date DESC LIMIT ?`,
      )
      .all(contract.toUpperCase(), days) as Array<Record<string, unknown>>;
    return rows.map(mapContractDaily).reverse();
  }

  getContractDailyByUnderlying(underlying: string, sessionDate: string): ContractDailyRow[] {
    const rows = this.db
      .prepare("SELECT * FROM contract_daily WHERE underlying = ? AND session_date = ?")
      .all(underlying.toUpperCase(), sessionDate) as Array<Record<string, unknown>>;
    return rows.map(mapContractDaily);
  }

  contractDailySessionDates(underlying?: string): string[] {
    const rows = (
      underlying
        ? this.db
            .prepare(
              "SELECT DISTINCT session_date AS d FROM contract_daily WHERE underlying = ? ORDER BY d ASC",
            )
            .all(underlying.toUpperCase())
        : this.db
            .prepare("SELECT DISTINCT session_date AS d FROM contract_daily ORDER BY d ASC")
            .all()
    ) as Array<{ d: string }>;
    return rows.map((r) => r.d);
  }

  upsertUnderlyingDaily(rows: UnderlyingDailyRow[]): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO underlying_daily (underlying, session_date, spot_close, atm_iv)
       VALUES (?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((all: UnderlyingDailyRow[]) => {
      for (const r of all)
        stmt.run(r.underlying.toUpperCase(), r.sessionDate, r.spotClose, r.atmIv);
    });
    tx(rows);
  }

  getUnderlyingDaily(underlying: string, days = 260): UnderlyingDailyRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM underlying_daily WHERE underlying = ? ORDER BY session_date DESC LIMIT ?",
      )
      .all(underlying.toUpperCase(), days) as Array<Record<string, unknown>>;
    return rows
      .map((r) => ({
        underlying: r.underlying as string,
        sessionDate: r.session_date as string,
        spotClose: r.spot_close as number | null,
        atmIv: r.atm_iv as number | null,
      }))
      .reverse();
  }

  upsertShortVolume(rows: ShortVolumeRow[]): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO short_volume_daily
       (symbol, session_date, short_volume, short_exempt_volume, total_volume, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((all: ShortVolumeRow[]) => {
      for (const r of all) {
        stmt.run(
          r.symbol.toUpperCase(),
          r.sessionDate,
          r.shortVolume,
          r.shortExemptVolume,
          r.totalVolume,
          r.source,
        );
      }
    });
    tx(rows);
  }

  getShortVolume(symbol: string, days = 30): ShortVolumeRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM short_volume_daily WHERE symbol = ? ORDER BY session_date DESC LIMIT ?",
      )
      .all(symbol.toUpperCase(), days) as Array<Record<string, unknown>>;
    return rows
      .map((r) => ({
        symbol: r.symbol as string,
        sessionDate: r.session_date as string,
        shortVolume: r.short_volume as number,
        shortExemptVolume: r.short_exempt_volume as number,
        totalVolume: r.total_volume as number,
        source: r.source as string,
      }))
      .reverse();
  }

  netFlow(from: number, to: number): NetFlowRow[] {
    const rows = this.db
      .prepare(
        `SELECT underlying,
                COUNT(*) AS events,
                SUM(CASE WHEN json_extract(json, '$.right') = 'C' AND side = 'buy' THEN premium ELSE 0 END) AS cb,
                SUM(CASE WHEN json_extract(json, '$.right') = 'C' AND side = 'sell' THEN premium ELSE 0 END) AS cs,
                SUM(CASE WHEN json_extract(json, '$.right') = 'P' AND side = 'buy' THEN premium ELSE 0 END) AS pb,
                SUM(CASE WHEN json_extract(json, '$.right') = 'P' AND side = 'sell' THEN premium ELSE 0 END) AS ps
         FROM events WHERE ts >= ? AND ts <= ?
         GROUP BY underlying`,
      )
      .all(from, to) as Array<{
      underlying: string;
      events: number;
      cb: number;
      cs: number;
      pb: number;
      ps: number;
    }>;
    return rows
      .map((r) => ({
        underlying: r.underlying,
        events: r.events,
        callBuyPremium: round2(r.cb),
        callSellPremium: round2(r.cs),
        putBuyPremium: round2(r.pb),
        putSellPremium: round2(r.ps),
        netPremium: round2(r.cb - r.cs - (r.pb - r.ps)),
      }))
      .sort((a, b) => Math.abs(b.netPremium) - Math.abs(a.netPremium));
  }

  listRules(): StoredRule[] {
    const rows = this.db
      .prepare("SELECT json, source, created_ts, updated_ts FROM rules ORDER BY created_ts ASC")
      .all() as Array<{ json: string; source: string; created_ts: number; updated_ts: number }>;
    return rows.map((r) => ({
      rule: alertRuleSchema.parse(JSON.parse(r.json)),
      source: r.source as StoredRule["source"],
      createdTs: r.created_ts,
      updatedTs: r.updated_ts,
    }));
  }

  upsertRule(rule: AlertRule, source: "config" | "dynamic"): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO rules (id, source, json, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET source = excluded.source, json = excluded.json, updated_ts = excluded.updated_ts`,
      )
      .run(rule.id, source, JSON.stringify(rule), now, now);
  }

  removeRule(id: string): boolean {
    return this.db.prepare("DELETE FROM rules WHERE id = ?").run(id).changes > 0;
  }

  insertAlertFired(alert: FiredAlert): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO alerts_fired (id, rule_id, event_id, ts, sink, ok, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        alert.id,
        alert.ruleId,
        alert.eventId,
        alert.ts,
        alert.sink,
        alert.ok ? 1 : 0,
        alert.detail ?? null,
      );
  }

  listAlertsFired(limit = 100, ruleId?: string): FiredAlert[] {
    const rows = (
      ruleId
        ? this.db
            .prepare("SELECT * FROM alerts_fired WHERE rule_id = ? ORDER BY ts DESC LIMIT ?")
            .all(ruleId, limit)
        : this.db.prepare("SELECT * FROM alerts_fired ORDER BY ts DESC LIMIT ?").all(limit)
    ) as Array<{
      id: string;
      rule_id: string;
      event_id: string;
      ts: number;
      sink: string;
      ok: number;
      detail: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      ruleId: r.rule_id,
      eventId: r.event_id,
      ts: r.ts,
      sink: r.sink,
      ok: r.ok === 1,
      ...(r.detail ? { detail: r.detail } : {}),
    }));
  }

  heartbeat(stats: EngineStats): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('heartbeat_ts', ?)")
        .run(String(Date.now()));
      this.db
        .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('engine_stats', ?)")
        .run(JSON.stringify(stats));
    });
    tx();
  }

  status(): StoreStatus {
    const one = (sql: string) =>
      (this.db.prepare(sql).get() ?? {}) as Record<string, number | null>;
    const ticks = one("SELECT COUNT(*) AS n, MIN(ts) AS min_ts, MAX(ts) AS max_ts FROM ticks_raw");
    const events = one("SELECT COUNT(*) AS n, MAX(ts) AS max_ts FROM events");
    const rules = one("SELECT COUNT(*) AS n FROM rules");
    const alerts = one("SELECT COUNT(*) AS n FROM alerts_fired");
    const meta = new Map(
      (
        this.db.prepare("SELECT key, value FROM meta").all() as Array<{
          key: string;
          value: string;
        }>
      ).map((r) => [r.key, r.value]),
    );
    let dbSizeBytes: number | null = null;
    if (this.path !== ":memory:") {
      try {
        dbSizeBytes = statSync(this.path).size;
      } catch {
        dbSizeBytes = null;
      }
    }
    const heartbeat = meta.get("heartbeat_ts");
    const engineStats = meta.get("engine_stats");
    return {
      ticks: (ticks.n as number) ?? 0,
      events: (events.n as number) ?? 0,
      rules: (rules.n as number) ?? 0,
      alertsFired: (alerts.n as number) ?? 0,
      firstTickTs: (ticks.min_ts as number | null) ?? null,
      lastTickTs: (ticks.max_ts as number | null) ?? null,
      lastEventTs: (events.max_ts as number | null) ?? null,
      baselineSessions: this.baselineSessionDates(),
      dbSizeBytes,
      heartbeatTs: heartbeat ? Number(heartbeat) : null,
      engineStats: engineStats ? (JSON.parse(engineStats) as EngineStats) : null,
    };
  }

  prune(ticksRetentionDays: number, eventsRetentionDays: number, nowTs: number) {
    const tickCutoff = nowTs - ticksRetentionDays * 86_400_000;
    const eventCutoff = nowTs - eventsRetentionDays * 86_400_000;
    const ticksDeleted = this.db
      .prepare("DELETE FROM ticks_raw WHERE ts < ?")
      .run(tickCutoff).changes;
    const eventsDeleted = this.db
      .prepare("DELETE FROM events WHERE ts < ?")
      .run(eventCutoff).changes;
    return { ticksDeleted, eventsDeleted };
  }

  close(): void {
    this.db.close();
  }
}

function mapContractDaily(r: Record<string, unknown>): ContractDailyRow {
  return {
    contract: r.contract as string,
    sessionDate: r.session_date as string,
    underlying: r.underlying as string,
    expiry: r.expiry as string,
    strike: r.strike as number,
    right: r.right as "C" | "P",
    oi: r.oi as number | null,
    iv: r.iv as number | null,
    mid: r.mid as number | null,
    volume: r.volume as number | null,
  };
}

function round2(v: number | null): number {
  return Math.round((v ?? 0) * 100) / 100;
}
