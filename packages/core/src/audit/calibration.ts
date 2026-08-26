/*
  `whale audit` — outcome calibration of whale scores against forward moves
  of the UNDERLYING, computed entirely from the user's own flight recorder.

  This is a measuring instrument, not a performance claim. It answers one
  narrow question — "on the tape I recorded, did higher-scored events precede
  underlying moves in their direction more often than the base rate?" — and
  it answers it skeptically: exclusions are counted and reported, small
  buckets are flagged as noise, option P&L is never computed (path- and
  spread-dependent), and every report ships a non-optional caveats block.

  Forward-price sources, in priority order per horizon (documented in the
  report's caveats and in docs/audit.md):
    1. intra-session ("15m"/"1h"): the store's own ticks carry per-print spot
       observations; the forward price is the spot on the first tick of the
       underlying at ts ≥ event.ts + horizon, accepted only within a 20-minute
       tolerance — otherwise the event counts as noPriceData.
    2. same session ("eod"): underlying_daily.spotClose for the event's
       sessionDate; when that row is absent, the last recorded spot
       observation of the same session (at or after the event).
    3. cross-session ("1d"/"5d"): underlying_daily.spotClose of the 1st/5th
       RECORDED session date after the event's sessionDate; null when the
       daily history is missing or too short.

  Determinism: the report is a pure function of the store contents and the
  options — same store ⇒ byte-identical report.
*/

import type { FlightRecorder } from "../store/types.js";
import type { EventKind, FlowEvent } from "../types.js";
import { easternTimeToUtc, round } from "../util/session.js";

export type AuditHorizon = "15m" | "1h" | "eod" | "1d" | "5d";

export const AUDIT_HORIZONS: AuditHorizon[] = ["15m", "1h", "eod", "1d", "5d"];

/** Intra-session horizons in ms; "eod"/"1d"/"5d" resolve via session dates. */
const INTRA_HORIZON_MS: Partial<Record<AuditHorizon, number>> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
};

/** Max staleness accepted for an intra-session forward observation. */
const INTRA_TOLERANCE_MS = 20 * 60_000;

/** Buckets below this n are flagged: too few events to mean anything. */
export const SMALL_N = 30;

export interface CalibrationBucket {
  label: string;
  n: number;
  medianFwdReturnPct: number | null;
  meanFwdReturnPct: number | null;
  /** Fraction (as a percent) of events whose underlying moved their way. */
  alignedPct: number | null;
  /** n < 30 — treat this row as noise, not signal. */
  smallN: boolean;
}

export interface CalibrationReport {
  window: { from: number; to: number };
  horizon: string;
  eventsConsidered: number;
  eventsWithOutcome: number;
  excluded: { mid: number; unknown: number; noPriceData: number };
  /** Fixed 10-point score bins ("0-10" … "90-100"); empty bins dropped. */
  buckets: CalibrationBucket[];
  byKind: CalibrationBucket[];
  bySide: CalibrationBucket[];
  /** All events with an outcome in the same window — the honest comparator. */
  baseRate: { alignedPct: number | null; medianFwdReturnPct: number | null };
  /** Always populated. Not optional, not hidden. Relay these with the numbers. */
  caveats: string[];
}

export interface CalibrateOptions {
  store: FlightRecorder;
  from: number;
  to: number;
  horizon: AuditHorizon;
  underlying?: string;
  excludeColdStart?: boolean;
}

/** One event that survived exclusion, with its resolved forward return. */
interface Outcome {
  score: number;
  kind: EventKind;
  side: "buy" | "sell";
  fwdReturnPct: number;
  aligned: boolean;
}

/**
 * queryEvents caps each page at 1000 rows (newest first), so a large window
 * is paged by walking `to` down to the oldest ts seen, deduping by id.
 */
function collectEventsAsc(
  store: FlightRecorder,
  filter: { from: number; to: number; underlying?: string; excludeColdStart?: boolean },
): FlowEvent[] {
  const out: FlowEvent[] = [];
  const seen = new Set<string>();
  let to = filter.to;
  for (;;) {
    const page = store.queryEvents({
      from: filter.from,
      to,
      underlying: filter.underlying,
      excludeColdStart: filter.excludeColdStart,
      limit: 1000,
      orderBy: "ts",
    });
    let added = 0;
    let oldest = to;
    for (const e of page) {
      oldest = Math.min(oldest, e.ts);
      if (!seen.has(e.id)) {
        seen.add(e.id);
        out.push(e);
        added++;
      }
    }
    if (page.length < 1000) break;
    // No new ids on a full page ⇒ >1000 events share one ts; step past it.
    to = added === 0 ? oldest - 1 : oldest;
    if (to < filter.from) break;
  }
  out.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  return out;
}

/** Spot observations for one underlying, sorted by ts — the forward-price series. */
interface SpotSeries {
  ts: number[];
  spot: number[];
}

/**
 * One streaming pass over the underlying's ticks (iterateTicks yields in seq
 * order, which a live tape does not guarantee is ts order — so the collected
 * observations are sorted once). Memory is two numbers per observation, never
 * whole ticks.
 */
function collectSpotSeries(
  store: FlightRecorder,
  underlying: string,
  from: number,
  to: number,
): SpotSeries {
  const pairs: Array<[number, number]> = [];
  for (const tick of store.iterateTicks({ underlying, from, to })) {
    if (tick.spot !== null) pairs.push([tick.ts, tick.spot]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return { ts: pairs.map((p) => p[0]), spot: pairs.map((p) => p[1]) };
}

/** Index of the first observation with ts ≥ target, or series.ts.length. */
function lowerBound(ts: number[], target: number): number {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Forward spot at event.ts + horizon from tick observations, or null. */
function intraSessionForward(
  series: SpotSeries,
  eventTs: number,
  horizonMs: number,
): number | null {
  const target = eventTs + horizonMs;
  const i = lowerBound(series.ts, target);
  if (i >= series.ts.length) return null;
  if (series.ts[i]! - target > INTRA_TOLERANCE_MS) return null;
  return series.spot[i]!;
}

/** Last spot observation of the event's own session, at or after the event. */
function lastSpotOfSession(
  series: SpotSeries,
  eventTs: number,
  sessionDate: string,
): number | null {
  // End of the Eastern calendar day (hour 24 rolls over correctly in Date.UTC).
  const sessionEnd = easternTimeToUtc(sessionDate, 24);
  const i = lowerBound(series.ts, sessionEnd);
  // Walk back to the last observation before session end that is ≥ event ts.
  const j = i - 1;
  if (j < 0 || series.ts[j]! < eventTs) return null;
  return series.spot[j]!;
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function summarize(label: string, outcomes: Outcome[]): CalibrationBucket {
  const returns = outcomes.map((o) => o.fwdReturnPct).sort((a, b) => a - b);
  const n = outcomes.length;
  const med = median(returns);
  const mean = n === 0 ? null : returns.reduce((s, r) => s + r, 0) / n;
  const aligned = n === 0 ? null : (100 * outcomes.filter((o) => o.aligned).length) / n;
  return {
    label,
    n,
    medianFwdReturnPct: med === null ? null : round(med, 4),
    meanFwdReturnPct: mean === null ? null : round(mean, 4),
    alignedPct: aligned === null ? null : round(aligned, 2),
    smallN: n < SMALL_N,
  };
}

const KIND_ORDER: EventKind[] = ["sweep", "block", "split", "print"];

/**
 * Calibrate recorded whale scores against forward returns of the UNDERLYING.
 * Pure computation over the store — deterministic given the store contents.
 * See the module header for forward-price sources and docs/audit.md for how
 * to read (and how not to over-read) the result.
 */
export async function calibrate(opts: CalibrateOptions): Promise<CalibrationReport> {
  const { store, from, to, horizon } = opts;
  if (to <= from) throw new Error("'to' must be after 'from'");
  if (!AUDIT_HORIZONS.includes(horizon)) {
    throw new Error(`unknown horizon '${horizon}'; one of ${AUDIT_HORIZONS.join(", ")}`);
  }

  const events = collectEventsAsc(store, {
    from,
    to,
    underlying: opts.underlying,
    excludeColdStart: opts.excludeColdStart,
  });

  const excluded = { mid: 0, unknown: 0, noPriceData: 0 };
  const directional: FlowEvent[] = [];
  for (const e of events) {
    if (e.side === "mid") excluded.mid++;
    else if (e.side === "unknown") excluded.unknown++;
    else if (e.spot === null || e.spot <= 0) excluded.noPriceData++;
    else directional.push(e);
  }

  // Group by underlying so each underlying's tape is streamed exactly once.
  const byUnderlying = new Map<string, FlowEvent[]>();
  for (const e of directional) {
    const list = byUnderlying.get(e.underlying);
    if (list) list.push(e);
    else byUnderlying.set(e.underlying, [e]);
  }

  const intraMs = INTRA_HORIZON_MS[horizon];
  const outcomes: Outcome[] = [];

  for (const [underlying, list] of [...byUnderlying.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    let series: SpotSeries | null = null;
    let dailyDates: string[] = [];
    let dailyClose = new Map<string, number | null>();

    if (intraMs !== undefined) {
      series = collectSpotSeries(store, underlying, from, to + intraMs + INTRA_TOLERANCE_MS);
    } else {
      const rows = store.getUnderlyingDaily(underlying, 100_000);
      dailyDates = rows.map((r) => r.sessionDate);
      dailyClose = new Map(rows.map((r) => [r.sessionDate, r.spotClose]));
      if (horizon === "eod") {
        // Tick fallback for sessions without a recorded daily close.
        series = collectSpotSeries(store, underlying, from, to + 86_400_000);
      }
    }

    for (const e of list) {
      const spot0 = e.spot!;
      let fwd: number | null = null;
      if (intraMs !== undefined) {
        fwd = intraSessionForward(series!, e.ts, intraMs);
      } else if (horizon === "eod") {
        fwd = dailyClose.get(e.sessionDate) ?? null;
        if (fwd === null) fwd = lastSpotOfSession(series!, e.ts, e.sessionDate);
      } else {
        const ahead = horizon === "1d" ? 1 : 5;
        const idx = dailyDates.findIndex((d) => d > e.sessionDate);
        const targetDate = idx === -1 ? undefined : dailyDates[idx + ahead - 1];
        fwd = targetDate === undefined ? null : (dailyClose.get(targetDate) ?? null);
      }
      if (fwd === null || fwd <= 0) {
        excluded.noPriceData++;
        continue;
      }
      const fwdReturnPct = round(((fwd - spot0) / spot0) * 100, 4);
      // A zero move never counts as aligned — the tape gets no benefit of the doubt.
      const aligned = e.side === "buy" ? fwdReturnPct > 0 : fwdReturnPct < 0;
      outcomes.push({
        score: e.score.total,
        kind: e.kind,
        side: e.side as "buy" | "sell",
        fwdReturnPct,
        aligned,
      });
    }
  }

  // Fixed 10-point score bins — stable across runs, unlike observed-score deciles.
  const binned: Outcome[][] = Array.from({ length: 10 }, () => []);
  for (const o of outcomes) binned[Math.min(9, Math.floor(o.score / 10))]!.push(o);
  const buckets = binned
    .map((list, i) => summarize(`${i * 10}-${i === 9 ? 100 : (i + 1) * 10}`, list))
    .filter((b) => b.n > 0);

  const byKind = KIND_ORDER.map((k) =>
    summarize(
      k,
      outcomes.filter((o) => o.kind === k),
    ),
  ).filter((b) => b.n > 0);
  const bySide = (["buy", "sell"] as const)
    .map((s) =>
      summarize(
        s,
        outcomes.filter((o) => o.side === s),
      ),
    )
    .filter((b) => b.n > 0);

  const base = summarize("all", outcomes);

  const sourceLine =
    intraMs !== undefined
      ? `recorded tick spot observations: first observation at ts ≥ event time + ${horizon}, ` +
        `accepted within a ${INTRA_TOLERANCE_MS / 60_000}-minute tolerance, else excluded as noPriceData`
      : horizon === "eod"
        ? "underlying_daily.spotClose for the event's session; when absent, the last recorded " +
          "spot observation of that session at or after the event"
        : `underlying_daily.spotClose of the ${horizon === "1d" ? "1st" : "5th"} recorded session ` +
          "date after the event's session; excluded as noPriceData when the daily history is missing";

  const caveats: string[] = [
    `Forward prices for horizon ${horizon} come from ${sourceLine}. Gaps in your recording are gaps in this report.`,
    "Selection effects: this measures only what your recorder captured: the windows you ran the engine, the universe you subscribed, the events your config emitted. It says nothing about any other tape.",
    "Returns are moves of the UNDERLYING, not option P&L. No transaction costs, spreads, slippage, or exercise mechanics are modeled; an aligned underlying move does not imply the option made money. That is also why no option win rate is computed here: option P&L is path-dependent and spread-dependent, and a number we could not defend would be worse than none.",
    `Buckets with n < ${SMALL_N} are flagged smallN and should be read as noise, not signal.`,
    "Alignment counts an exact-zero move as NOT aligned; mid and unknown-side events are excluded from alignment entirely (counted in `excluded`). Compare alignedPct to BOTH the 50% coin flip and the report's baseRate; a drifting tape moves every bucket.",
    "Correlation is not causation. A calibration table is a measurement of one recorded window, not a forecast and not trading advice.",
  ];
  if (outcomes.length === 0) {
    caveats.push(
      "No events had a resolvable outcome in this window; every table is empty. Check the window against your recorded coverage before reading anything into that.",
    );
  }
  if (events.some((e) => e.feedId === "synthetic")) {
    caveats.push(
      "SYNTHETIC TAPE: this window contains events from the seeded synthetic feed. Outcomes are meaningless by construction; this run demonstrates the instrument only.",
    );
  }

  return {
    window: { from, to },
    horizon,
    eventsConsidered: events.length,
    eventsWithOutcome: outcomes.length,
    excluded,
    buckets,
    byKind,
    bySide,
    baseRate: { alignedPct: base.alignedPct, medianFwdReturnPct: base.medianFwdReturnPct },
    caveats,
  };
}
