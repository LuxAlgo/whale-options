/*
  The runner — where the pure engine meets the async world. It owns the whole
  I/O choreography: pull raw prints from the adapter, normalize, attach any
  enrichment the vendor didn't send (NBBO/spot/OI via cached lookups), feed
  the engine, batch writes into the flight recorder, dispatch alerts, and
  keep the tape recorder rolling. In replay mode all of that collapses to
  "ticks in, events out" — no lookups, no wall clock — because tapes are
  already self-contained.
*/

import { AlertDispatcher } from "./alerts/dispatcher.js";
import type { WhaleConfig } from "./config.js";
import { Engine } from "./engine.js";
import type { TapeWriter } from "./feeds/replay.js";
import type { FeedAdapter } from "./feeds/types.js";
import { normalizeTrade } from "./normalize/normalize.js";
import type { FlightRecorder } from "./store/types.js";
import type { ChainSnapshot, EngineStats, FlowEvent, Nbbo, OptionTradeTick } from "./types.js";
import { round, sessionDateOf } from "./util/session.js";

export interface RunnerOptions {
  config: WhaleConfig;
  adapter: FeedAdapter;
  store: FlightRecorder;
  signal?: AbortSignal;
  onEvent?: (event: FlowEvent) => void;
  onTick?: (tick: OptionTradeTick) => void;
  record?: TapeWriter;
  /** Pure tape replay: no enrichment, no alerts, no persistence of ticks. */
  replayMode?: boolean;
  /** Replay windows: hydrate baselines only from sessions before this date. */
  baselinesBefore?: string;
}

export interface RunSummary {
  stats: EngineStats;
  droppedTicks: number;
  alertsMatched: number;
}

class TtlCache<T> {
  private values = new Map<string, { value: T; at: number }>();
  constructor(private readonly ttlMs: number) {}
  get(key: string): T | undefined {
    const hit = this.values.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) {
      this.values.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key: string, value: T): void {
    this.values.set(key, { value, at: Date.now() });
  }
}

export async function runEngine(options: RunnerOptions): Promise<RunSummary> {
  const { config, adapter, store, signal, record } = options;
  const replayMode = options.replayMode ?? false;

  // Seed config-declared rules so the dispatcher (and MCP/CLI) see them.
  if (!replayMode) {
    for (const rule of config.alerts.rules) store.upsertRule(rule, "config");
  }

  const baselines = store.loadBaselineState(config.score.lookbackDays, options.baselinesBefore);
  const engine = new Engine(config, baselines);
  const dispatcher = replayMode ? null : new AlertDispatcher(store);

  // Enrichment caches, live mode only. OI comes from chain snapshots.
  const nbboCache = new TtlCache<Nbbo | null>(2_000);
  const spotCache = new TtlCache<number | null>(30_000);
  const oiByContract = new Map<string, number>();

  const refreshChains = async () => {
    for (const underlying of config.universe.underlyings) {
      try {
        const snap = await adapter.getChainSnapshot(underlying);
        if (!snap) continue;
        store.upsertChainSnapshot(snap);
        foldChainToDaily(store, snap);
        for (const c of snap.contracts) {
          if (c.oi !== null && c.oi !== undefined) oiByContract.set(c.contract, c.oi);
        }
      } catch {
        // A missing chain degrades vol/OI and GEX for that name; the tape keeps flowing.
      }
    }
  };
  if (!replayMode) await refreshChains();

  let nextSeq = replayMode ? 0 : (store.maxTickSeq() ?? -1) + 1;
  let droppedTicks = 0;
  let alertsMatched = 0;
  let lastArrivalWall = Date.now();

  const tickBuffer: OptionTradeTick[] = [];
  const eventBuffer: FlowEvent[] = [];
  const flushBuffers = () => {
    if (tickBuffer.length > 0) {
      store.insertTicks(tickBuffer.splice(0, tickBuffer.length));
    }
    if (eventBuffer.length > 0) {
      store.insertEvents(eventBuffer.splice(0, eventBuffer.length));
    }
  };

  const handleEvents = (events: FlowEvent[]) => {
    for (const event of events) {
      eventBuffer.push(event);
      options.onEvent?.(event);
      if (dispatcher) alertsMatched += dispatcher.dispatch(event);
    }
    for (const rows of engine.drainDayRows()) store.saveBaselineDay(rows);
  };

  const timers: NodeJS.Timeout[] = [];
  if (!replayMode) {
    // Idle flusher: when the stream goes quiet in wall time, resolve open
    // event-time windows so live output doesn't hang on the last sweep.
    const idleMs = Math.max(1000, config.engine.sweepWindowMs * 2);
    timers.push(
      setInterval(() => {
        if (Date.now() - lastArrivalWall > idleMs) handleEvents(engine.flush());
      }, 250),
    );
    timers.push(
      setInterval(() => {
        flushBuffers();
        store.heartbeat(engine.getStats());
      }, 5_000),
    );
    timers.push(setInterval(refreshChains, 6 * 3_600_000));
    for (const t of timers) t.unref();
  }

  try {
    for await (const raw of adapter.subscribeOptionTrades(
      { underlyings: config.universe.underlyings },
      signal,
    )) {
      lastArrivalWall = Date.now();
      const { tick } = normalizeTrade(raw, adapter.id, nextSeq, (code) =>
        adapter.normalizeCondition(code),
      );
      if (!tick) {
        droppedTicks++;
        continue;
      }
      nextSeq = Math.max(nextSeq, tick.seq) + 1;

      if (!replayMode) {
        if (tick.nbbo === null) {
          let nbbo = nbboCache.get(tick.contract);
          if (nbbo === undefined) {
            nbbo = await adapter.getNbbo(tick.contract).catch(() => null);
            nbboCache.set(tick.contract, nbbo);
          }
          tick.nbbo = nbbo ?? null;
        }
        if (tick.spot === null && adapter.getSpot) {
          let spot = spotCache.get(tick.underlying);
          if (spot === undefined) {
            spot = await adapter.getSpot(tick.underlying).catch(() => null);
            spotCache.set(tick.underlying, spot);
          }
          tick.spot = spot ?? null;
        }
        if (tick.oi === null) tick.oi = oiByContract.get(tick.contract) ?? null;
      }

      record?.write(tick);
      options.onTick?.(tick);
      if (!replayMode) {
        tickBuffer.push(tick);
        if (tickBuffer.length >= 500) flushBuffers();
      }

      handleEvents(engine.push(tick));
    }
  } finally {
    for (const t of timers) clearInterval(t);
    handleEvents(engine.flush());
    const finalRows = engine.closeSession();
    if (finalRows && !replayMode) store.saveBaselineDay(finalRows);
    flushBuffers();
    if (dispatcher) await dispatcher.drain();
    if (!replayMode) {
      store.heartbeat(engine.getStats());
      store.prune(config.store.ticksRetentionDays, config.store.eventsRetentionDays, Date.now());
    }
    await record?.close();
  }

  return { stats: engine.getStats(), droppedTicks, alertsMatched };
}

/**
 * Fold a chain snapshot into the daily-history tables. Repeated refreshes
 * within one session overwrite the same (contract, session_date) row, so the
 * last refresh of the day stands as that session's end state — the substrate
 * for OI deltas, IV history, and forward-return audits.
 */
export function foldChainToDaily(store: FlightRecorder, snap: ChainSnapshot): void {
  const sessionDate = sessionDateOf(snap.ts);
  store.upsertContractDaily(
    snap.contracts.map((c) => ({
      contract: c.contract,
      sessionDate,
      underlying: snap.underlying,
      expiry: c.expiry,
      strike: c.strike,
      right: c.right,
      oi: c.oi ?? null,
      iv: c.iv ?? null,
      mid: c.nbbo && c.nbbo.ask > 0 ? round((c.nbbo.bid + c.nbbo.ask) / 2, 4) : null,
      volume: c.volume ?? null,
    })),
  );
  store.upsertUnderlyingDaily([
    {
      underlying: snap.underlying,
      sessionDate,
      spotClose: snap.spot,
      atmIv: atmIvOf(snap),
    },
  ]);
}

/** IV of the nearest-the-money contracts in the nearest expiry, C/P averaged. */
function atmIvOf(snap: ChainSnapshot): number | null {
  if (snap.spot === null || snap.spot <= 0) return null;
  const spot = snap.spot;
  const withIv = snap.contracts.filter((c) => c.iv !== null && c.iv !== undefined && c.iv > 0);
  if (withIv.length === 0) return null;
  const nearestExpiry = [...new Set(withIv.map((c) => c.expiry))].sort()[0];
  const nearMoney = withIv
    .filter((c) => c.expiry === nearestExpiry)
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
    .slice(0, 2);
  if (nearMoney.length === 0) return null;
  const avg = nearMoney.reduce((acc, c) => acc + (c.iv ?? 0), 0) / nearMoney.length;
  return round(avg, 4);
}
