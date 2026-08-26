/*
  In-memory flight recorder — same contract as SQLite, zero I/O. Used by
  tests and `whale bench`, where store latency would otherwise pollute
  engine throughput numbers.
*/

import type { AlertRule } from "../config.js";
import { type BaselineDayRows, BaselineState } from "../score/baselines.js";
import type {
  ChainSnapshot,
  EngineStats,
  FiredAlert,
  FlowEvent,
  OptionTradeTick,
} from "../types.js";
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

export class MemoryFlightRecorder implements FlightRecorder {
  private ticks: OptionTradeTick[] = [];
  private events = new Map<string, FlowEvent>();
  private baselineDays = new Map<string, BaselineDayRows>();
  private chains = new Map<string, ChainSnapshot>();
  private contractDaily = new Map<string, ContractDailyRow>();
  private underlyingDaily = new Map<string, UnderlyingDailyRow>();
  private shortVolume = new Map<string, ShortVolumeRow>();
  private rules = new Map<string, StoredRule>();
  private alerts: FiredAlert[] = [];
  private heartbeatTs: number | null = null;
  private engineStats: EngineStats | null = null;

  insertTicks(ticks: OptionTradeTick[]): void {
    this.ticks.push(...ticks);
  }

  insertEvents(events: FlowEvent[]): void {
    for (const e of events) this.events.set(e.id, e);
  }

  getEvent(id: string): FlowEvent | null {
    return this.events.get(id) ?? null;
  }

  queryEvents(filter: EventFilter): FlowEvent[] {
    let rows = [...this.events.values()];
    if (filter.underlying)
      rows = rows.filter((e) => e.underlying === filter.underlying?.toUpperCase());
    if (filter.contract) rows = rows.filter((e) => e.contract === filter.contract?.toUpperCase());
    if (filter.kind) rows = rows.filter((e) => e.kind === filter.kind);
    if (filter.side) rows = rows.filter((e) => e.side === filter.side);
    if (filter.minPremium !== undefined)
      rows = rows.filter((e) => e.premium >= (filter.minPremium ?? 0));
    if (filter.minScore !== undefined)
      rows = rows.filter((e) => e.score.total >= (filter.minScore ?? 0));
    if (filter.excludeColdStart) rows = rows.filter((e) => !e.score.coldStart);
    if (filter.from !== undefined) rows = rows.filter((e) => e.ts >= (filter.from ?? 0));
    if (filter.to !== undefined)
      rows = rows.filter((e) => e.ts <= (filter.to ?? Number.POSITIVE_INFINITY));
    rows.sort(
      filter.orderBy === "score"
        ? (a, b) => b.score.total - a.score.total || b.ts - a.ts
        : (a, b) => b.ts - a.ts || b.seq - a.seq,
    );
    return rows.slice(0, Math.min(filter.limit ?? 100, 1000));
  }

  *iterateTicks(filter: TickFilter): Iterable<OptionTradeTick> {
    const rows = this.ticks
      .filter(
        (t) =>
          (filter.from === undefined || t.ts >= filter.from) &&
          (filter.to === undefined || t.ts <= filter.to) &&
          (!filter.underlying || t.underlying === filter.underlying.toUpperCase()) &&
          (!filter.contract || t.contract === filter.contract.toUpperCase()),
      )
      .sort((a, b) => a.seq - b.seq);
    yield* rows;
  }

  countTicks(filter: TickFilter): number {
    return [...this.iterateTicks(filter)].length;
  }

  maxTickSeq(): number | null {
    if (this.ticks.length === 0) return null;
    return this.ticks.reduce((max, t) => Math.max(max, t.seq), 0);
  }

  saveBaselineDay(rows: BaselineDayRows): void {
    this.baselineDays.set(rows.sessionDate, rows);
  }

  loadBaselineState(lookbackDays: number, beforeDate?: string): BaselineState {
    const state = BaselineState.empty(lookbackDays);
    const dates = [...this.baselineDays.keys()]
      .filter((d) => !beforeDate || d < beforeDate)
      .sort()
      .slice(-lookbackDays);
    for (const d of dates) {
      const rows = this.baselineDays.get(d);
      if (rows) state.loadDay(rows);
    }
    return state;
  }

  baselineSessionDates(): string[] {
    return [...this.baselineDays.keys()].sort();
  }

  upsertChainSnapshot(snapshot: ChainSnapshot): void {
    this.chains.set(snapshot.underlying.toUpperCase(), snapshot);
  }

  getChainSnapshot(underlying: string): ChainSnapshot | null {
    return this.chains.get(underlying.toUpperCase()) ?? null;
  }

  listChainSnapshots(): Array<{ underlying: string; ts: number }> {
    return [...this.chains.values()]
      .map((c) => ({ underlying: c.underlying, ts: c.ts }))
      .sort((a, b) => a.underlying.localeCompare(b.underlying));
  }

  upsertContractDaily(rows: ContractDailyRow[]): void {
    for (const r of rows) this.contractDaily.set(`${r.contract}|${r.sessionDate}`, r);
  }

  getContractDaily(contract: string, days = 30): ContractDailyRow[] {
    return [...this.contractDaily.values()]
      .filter((r) => r.contract === contract.toUpperCase())
      .sort((a, b) => a.sessionDate.localeCompare(b.sessionDate))
      .slice(-days);
  }

  getContractDailyByUnderlying(underlying: string, sessionDate: string): ContractDailyRow[] {
    return [...this.contractDaily.values()].filter(
      (r) => r.underlying === underlying.toUpperCase() && r.sessionDate === sessionDate,
    );
  }

  contractDailySessionDates(underlying?: string): string[] {
    const dates = new Set<string>();
    for (const r of this.contractDaily.values()) {
      if (!underlying || r.underlying === underlying.toUpperCase()) dates.add(r.sessionDate);
    }
    return [...dates].sort();
  }

  upsertUnderlyingDaily(rows: UnderlyingDailyRow[]): void {
    for (const r of rows)
      this.underlyingDaily.set(`${r.underlying.toUpperCase()}|${r.sessionDate}`, r);
  }

  getUnderlyingDaily(underlying: string, days = 260): UnderlyingDailyRow[] {
    return [...this.underlyingDaily.values()]
      .filter((r) => r.underlying.toUpperCase() === underlying.toUpperCase())
      .sort((a, b) => a.sessionDate.localeCompare(b.sessionDate))
      .slice(-days);
  }

  upsertShortVolume(rows: ShortVolumeRow[]): void {
    for (const r of rows) this.shortVolume.set(`${r.symbol.toUpperCase()}|${r.sessionDate}`, r);
  }

  getShortVolume(symbol: string, days = 30): ShortVolumeRow[] {
    return [...this.shortVolume.values()]
      .filter((r) => r.symbol.toUpperCase() === symbol.toUpperCase())
      .sort((a, b) => a.sessionDate.localeCompare(b.sessionDate))
      .slice(-days);
  }

  netFlow(from: number, to: number): NetFlowRow[] {
    const byUnderlying = new Map<string, NetFlowRow>();
    for (const e of this.events.values()) {
      if (e.ts < from || e.ts > to) continue;
      const row =
        byUnderlying.get(e.underlying) ??
        ({
          underlying: e.underlying,
          events: 0,
          callBuyPremium: 0,
          callSellPremium: 0,
          putBuyPremium: 0,
          putSellPremium: 0,
          netPremium: 0,
        } as NetFlowRow);
      row.events++;
      if (e.right === "C" && e.side === "buy") row.callBuyPremium += e.premium;
      if (e.right === "C" && e.side === "sell") row.callSellPremium += e.premium;
      if (e.right === "P" && e.side === "buy") row.putBuyPremium += e.premium;
      if (e.right === "P" && e.side === "sell") row.putSellPremium += e.premium;
      byUnderlying.set(e.underlying, row);
    }
    return [...byUnderlying.values()]
      .map((r) => ({
        ...r,
        callBuyPremium: round2(r.callBuyPremium),
        callSellPremium: round2(r.callSellPremium),
        putBuyPremium: round2(r.putBuyPremium),
        putSellPremium: round2(r.putSellPremium),
        netPremium: round2(
          r.callBuyPremium - r.callSellPremium - (r.putBuyPremium - r.putSellPremium),
        ),
      }))
      .sort((a, b) => Math.abs(b.netPremium) - Math.abs(a.netPremium));
  }

  listRules(): StoredRule[] {
    return [...this.rules.values()].sort((a, b) => a.createdTs - b.createdTs);
  }

  upsertRule(rule: AlertRule, source: "config" | "dynamic"): void {
    const existing = this.rules.get(rule.id);
    const now = Date.now();
    this.rules.set(rule.id, {
      rule,
      source,
      createdTs: existing?.createdTs ?? now,
      updatedTs: now,
    });
  }

  removeRule(id: string): boolean {
    return this.rules.delete(id);
  }

  insertAlertFired(alert: FiredAlert): void {
    this.alerts.push(alert);
  }

  listAlertsFired(limit = 100, ruleId?: string): FiredAlert[] {
    return this.alerts
      .filter((a) => !ruleId || a.ruleId === ruleId)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
  }

  heartbeat(stats: EngineStats): void {
    this.heartbeatTs = Date.now();
    this.engineStats = stats;
  }

  status(): StoreStatus {
    const first = this.ticks[0];
    const last = this.ticks[this.ticks.length - 1];
    let lastEventTs: number | null = null;
    for (const e of this.events.values()) lastEventTs = Math.max(lastEventTs ?? 0, e.ts);
    return {
      ticks: this.ticks.length,
      events: this.events.size,
      rules: this.rules.size,
      alertsFired: this.alerts.length,
      firstTickTs: first?.ts ?? null,
      lastTickTs: last?.ts ?? null,
      lastEventTs,
      baselineSessions: this.baselineSessionDates(),
      dbSizeBytes: null,
      heartbeatTs: this.heartbeatTs,
      engineStats: this.engineStats,
    };
  }

  prune(ticksRetentionDays: number, eventsRetentionDays: number, nowTs: number) {
    const tickCutoff = nowTs - ticksRetentionDays * 86_400_000;
    const eventCutoff = nowTs - eventsRetentionDays * 86_400_000;
    const beforeTicks = this.ticks.length;
    this.ticks = this.ticks.filter((t) => t.ts >= tickCutoff);
    let eventsDeleted = 0;
    for (const [id, e] of this.events) {
      if (e.ts < eventCutoff) {
        this.events.delete(id);
        eventsDeleted++;
      }
    }
    return { ticksDeleted: beforeTicks - this.ticks.length, eventsDeleted };
  }

  close(): void {
    // nothing to release
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
