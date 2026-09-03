/*
  Per-print flow series — the intraday tape aggregated from EVERY normalized
  print, not only the events the engine emits above its premium floor.

  Per (underlying, session date), bucketed on the clock (1-minute by default):
  signed premium for calls and puts, directional delta (Σ delta × size × 100 ×
  sign), net volume (buy contracts − sell contracts), and a spot OHLC bar built
  from the underlying-price observations that rode on the option prints — the
  "spot tape from prints", never to be confused with exchange equity bars.

  Sign comes from the same aggressor inference the engine uses (price vs the
  NBBO stored on the print, under the sale-condition policy): buys are
  positive, sells negative, everything else (mid, unknown, sides voided by a
  condition) is excluded from the signed series and counted. Delta comes from
  the chain snapshot's greeks when the caller can supply them, otherwise from
  Black-Scholes over the print's own fields; a print with no derivable delta
  is excluded from that one series and counted as missing.

  The aggregator is a pure function of the ticks it is fed (plus the optional
  delta lookup): no wall clock, no randomness, fixed rounding — so replaying a
  tape through it reproduces the same buckets byte for byte.
*/

import { inferAggressor } from "../classify/aggressor.js";
import { isCancel, policyFor } from "../conditions.js";
import { blackScholes } from "../greeks/black-scholes.js";
import { solveIv } from "../greeks/brent.js";
import type { OptionTradeTick } from "../types.js";
import { dteOf, round, sessionDateOf } from "../util/session.js";

/** One clock bucket of one underlying's session; the unit persisted by the flight recorder. */
export interface FlowBucketRow {
  underlying: string;
  /** US-equity session date (America/New_York), e.g. "2026-08-24". */
  sessionDate: string;
  /** Bucket width the row was built with (ms). */
  bucketMs: number;
  /** Bucket start, epoch ms (floor(tick.ts / bucketMs) × bucketMs). */
  ts: number;
  /** Non-cancel prints landing in the bucket, whatever their side. */
  prints: number;
  /** Cancel prints seen (counted, otherwise ignored — nothing is retracted). */
  cancels: number;
  /** Prints whose aggressor side resolved to buy or sell. */
  sided: number;
  /** Prints excluded from every signed series: mid, unknown, or a side-voiding condition. */
  unsided: number;
  buyVolume: number;
  sellVolume: number;
  /** Positive dollar amounts; the signed nets are derived at read time. */
  callPremiumBuy: number;
  callPremiumSell: number;
  putPremiumBuy: number;
  putPremiumSell: number;
  /** Σ delta × size × 100 × sign over sided prints with a derivable delta. */
  directionalDelta: number;
  /** How many sided prints took their delta from chain-snapshot greeks. */
  deltaFromChain: number;
  /** How many sided prints took their delta from Black-Scholes on the print's own fields. */
  deltaFromBlackScholes: number;
  /** Sided prints with no derivable delta — excluded from directionalDelta, never guessed. */
  deltaMissing: number;
  /** Spot tape from prints: OHLC of tick.spot observations in the bucket; null when none. */
  spotOpen: number | null;
  spotHigh: number | null;
  spotLow: number | null;
  spotClose: number | null;
  /** Prints in the bucket that carried a spot observation. */
  spotObservations: number;
}

/** A bucket plus the derived signed and cumulative series a chart plots. */
export interface FlowSeriesPoint extends FlowBucketRow {
  /** callPremiumBuy − callPremiumSell. */
  callNet: number;
  /** putPremiumBuy − putPremiumSell. */
  putNet: number;
  /** callNet − putNet: bullish-positive, the net-flow convention. */
  netPremium: number;
  /** buyVolume − sellVolume. */
  netVolume: number;
  cumCallNet: number;
  cumPutNet: number;
  cumNetPremium: number;
  cumDirectionalDelta: number;
  cumNetVolume: number;
}

export interface FlowSeriesTotals {
  prints: number;
  cancels: number;
  sided: number;
  unsided: number;
  callNet: number;
  putNet: number;
  netPremium: number;
  directionalDelta: number;
  netVolume: number;
  deltaFromChain: number;
  deltaFromBlackScholes: number;
  deltaMissing: number;
  spotObservations: number;
}

export interface FlowSeriesPayload {
  underlying: string;
  sessionDate: string;
  bucketMs: number;
  buckets: FlowSeriesPoint[];
  totals: FlowSeriesTotals;
  /** Which delta source(s) fed directionalDelta, in words. */
  deltaSource: string;
  note: string;
}

export const FLOW_SERIES_NOTE =
  "Built from EVERY normalized print of the underlying in this session: the engine's premium " +
  "floor and emit policy do NOT apply, so this is the whole tape, not the event stream. Sign " +
  "comes from the aggressor side vs the NBBO stored on each print (at/above ask = buy, +; " +
  "at/below bid = sell, −); mid prints, unknown sides, and sale conditions that void the side " +
  "(spread legs, auctions, crosses, late/out-of-sequence reports) are excluded from every " +
  "signed series and counted in `unsided`. Cancels are counted in `cancels` and otherwise " +
  "ignored — already-aggregated prints are not retracted. netPremium = callNet − putNet " +
  "(bullish-positive, the same convention as net flow). directionalDelta = Σ delta × size × 100 " +
  "× sign over sided prints; the delta source per print is stated in `deltaSource` and counted " +
  "per bucket (deltaFromChain / deltaFromBlackScholes), and prints with no derivable delta are " +
  "excluded from that series and counted in `deltaMissing` — never guessed. netVolume = buy " +
  "contracts − sell contracts. Spot OHLC is the SPOT TAPE FROM PRINTS: the underlying-price " +
  "observations that rode on the option prints, not exchange equity bars — gaps are minutes " +
  "with no prints. Values reset per session date (America/New_York).";

/** Chain-snapshot delta for a contract: the caller's lookup, null when it has none. */
export type DeltaLookup = (tick: OptionTradeTick) => number | null;

export interface FlowSeriesOptions {
  /** Bucket width in ms (default 60_000). */
  bucketMs?: number;
  /** NBBO older than this vs the print ⇒ side unknown (the engine's nbboStaleMs). */
  nbboStaleMs: number;
  /** Risk-free rate for the Black-Scholes fallback delta. */
  r: number;
  /** Dividend yield for the fallback delta; per-underlying overrides win. */
  q: number;
  qByUnderlying?: Record<string, number>;
  /** Chain-snapshot greeks, when the run has them. Consulted before Black-Scholes. */
  deltaLookup?: DeltaLookup;
}

function key(underlying: string, sessionDate: string): string {
  return `${underlying}|${sessionDate}`;
}

function emptyBucket(
  underlying: string,
  sessionDate: string,
  bucketMs: number,
  ts: number,
): FlowBucketRow {
  return {
    underlying,
    sessionDate,
    bucketMs,
    ts,
    prints: 0,
    cancels: 0,
    sided: 0,
    unsided: 0,
    buyVolume: 0,
    sellVolume: 0,
    callPremiumBuy: 0,
    callPremiumSell: 0,
    putPremiumBuy: 0,
    putPremiumSell: 0,
    directionalDelta: 0,
    deltaFromChain: 0,
    deltaFromBlackScholes: 0,
    deltaMissing: 0,
    spotOpen: null,
    spotHigh: null,
    spotLow: null,
    spotClose: null,
    spotObservations: 0,
  };
}

/**
 * Black-Scholes delta from nothing but the print: IV solved from the NBBO
 * mid at print time, spot from the tick, time to the 16:00 ET close of the
 * expiry. Null when any input is missing or the IV solve fails (below
 * intrinsic, zero quote) — the caller counts it as missing.
 */
export function blackScholesDeltaFromTick(
  tick: OptionTradeTick,
  r: number,
  q: number,
): number | null {
  if (tick.spot === null || !(tick.spot > 0) || !tick.nbbo) return null;
  const { bid, ask } = tick.nbbo;
  if (!(ask > 0) || bid < 0) return null;
  const mid = (bid + ask) / 2;
  const tau = dteOf(tick.ts, tick.expiry) / 365;
  if (tau <= 0) return null;
  const iv = solveIv({
    targetPrice: mid,
    spot: tick.spot,
    strike: tick.strike,
    tau,
    r,
    q,
    right: tick.right,
  });
  if (iv === null || !(iv > 0)) return null;
  const delta = blackScholes({
    spot: tick.spot,
    strike: tick.strike,
    tau,
    iv,
    r,
    q,
    right: tick.right,
  }).delta;
  return Number.isFinite(delta) ? delta : null;
}

export class FlowSeriesAggregator {
  readonly bucketMs: number;
  private readonly opts: FlowSeriesOptions;
  /** (underlying|session) → bucket ts → row. */
  private readonly sessions = new Map<string, Map<number, FlowBucketRow>>();
  private readonly dirty = new Set<FlowBucketRow>();

  constructor(opts: FlowSeriesOptions) {
    this.opts = opts;
    this.bucketMs = opts.bucketMs ?? 60_000;
    if (!(this.bucketMs > 0) || !Number.isInteger(this.bucketMs)) {
      throw new Error(`flow series bucketMs must be a positive integer, got ${this.bucketMs}`);
    }
  }

  /** Seed already-persisted buckets (a restarted run continues its session instead of resetting). */
  hydrate(rows: FlowBucketRow[]): void {
    for (const row of rows) {
      if (row.bucketMs !== this.bucketMs) continue;
      const k = key(row.underlying, row.sessionDate);
      let buckets = this.sessions.get(k);
      if (!buckets) {
        buckets = new Map();
        this.sessions.set(k, buckets);
      }
      buckets.set(row.ts, { ...row });
    }
  }

  push(tick: OptionTradeTick): void {
    const sessionDate = sessionDateOf(tick.ts);
    const bucketTs = Math.floor(tick.ts / this.bucketMs) * this.bucketMs;
    const k = key(tick.underlying, sessionDate);
    let buckets = this.sessions.get(k);
    if (!buckets) {
      buckets = new Map();
      this.sessions.set(k, buckets);
    }
    let row = buckets.get(bucketTs);
    if (!row) {
      row = emptyBucket(tick.underlying, sessionDate, this.bucketMs, bucketTs);
      buckets.set(bucketTs, row);
    }
    this.dirty.add(row);

    if (isCancel(tick.conditions)) {
      row.cancels++;
      return;
    }
    row.prints++;

    if (tick.spot !== null && Number.isFinite(tick.spot) && tick.spot > 0) {
      const s = tick.spot;
      if (row.spotOpen === null) {
        row.spotOpen = s;
        row.spotHigh = s;
        row.spotLow = s;
      } else {
        row.spotHigh = Math.max(row.spotHigh ?? s, s);
        row.spotLow = Math.min(row.spotLow ?? s, s);
      }
      row.spotClose = s;
      row.spotObservations++;
    }

    // Same gate as the engine: a print its sale condition keeps out of scoring
    // (spread legs, auctions, crosses, reopenings) never gets a side here either.
    const policy = policyFor(tick.conditions);
    const side = policy.scoreEligible
      ? inferAggressor(tick, policy, this.opts.nbboStaleMs).side
      : "unknown";
    if (side !== "buy" && side !== "sell") {
      row.unsided++;
      return;
    }
    row.sided++;
    const sign = side === "buy" ? 1 : -1;
    const premium = round(tick.price * tick.size * 100, 2);
    if (side === "buy") row.buyVolume += tick.size;
    else row.sellVolume += tick.size;
    if (tick.right === "C") {
      if (side === "buy") row.callPremiumBuy = round(row.callPremiumBuy + premium, 2);
      else row.callPremiumSell = round(row.callPremiumSell + premium, 2);
    } else if (side === "buy") row.putPremiumBuy = round(row.putPremiumBuy + premium, 2);
    else row.putPremiumSell = round(row.putPremiumSell + premium, 2);

    let delta = this.opts.deltaLookup?.(tick) ?? null;
    if (delta !== null && Number.isFinite(delta)) {
      row.deltaFromChain++;
    } else {
      const q = this.opts.qByUnderlying?.[tick.underlying] ?? this.opts.q;
      delta = blackScholesDeltaFromTick(tick, this.opts.r, q);
      if (delta === null) {
        row.deltaMissing++;
        return;
      }
      row.deltaFromBlackScholes++;
    }
    row.directionalDelta = round(row.directionalDelta + delta * tick.size * 100 * sign, 4);
  }

  /** Buckets touched since the last drain — what to persist and broadcast. */
  drainDirty(): FlowBucketRow[] {
    const rows = [...this.dirty].sort(
      (a, b) =>
        a.underlying.localeCompare(b.underlying) ||
        a.sessionDate.localeCompare(b.sessionDate) ||
        a.ts - b.ts,
    );
    this.dirty.clear();
    return rows.map((r) => ({ ...r }));
  }

  /** All buckets of one session, ascending by ts (copies). */
  series(underlying: string, sessionDate: string): FlowBucketRow[] {
    const buckets = this.sessions.get(key(underlying.toUpperCase(), sessionDate));
    if (!buckets) return [];
    return [...buckets.values()].sort((a, b) => a.ts - b.ts).map((r) => ({ ...r }));
  }

  sessionDates(underlying?: string): string[] {
    const dates = new Set<string>();
    for (const k of this.sessions.keys()) {
      const [u, d] = k.split("|");
      if (d && (!underlying || u === underlying.toUpperCase())) dates.add(d);
    }
    return [...dates].sort();
  }

  underlyings(): string[] {
    const out = new Set<string>();
    for (const k of this.sessions.keys()) {
      const [u] = k.split("|");
      if (u) out.add(u);
    }
    return [...out].sort();
  }
}

/**
 * Re-bucket rows onto a coarser grid (targetMs must be a multiple of the rows'
 * bucketMs). Counts and premiums add; the spot bar merges OHLC in time order.
 */
export function resampleFlowBuckets(rows: FlowBucketRow[], targetMs: number): FlowBucketRow[] {
  if (rows.length === 0) return [];
  const sourceMs = rows[0]?.bucketMs ?? targetMs;
  if (targetMs === sourceMs) return rows.map((r) => ({ ...r }));
  if (!(targetMs > sourceMs) || targetMs % sourceMs !== 0) {
    throw new Error(`cannot resample ${sourceMs}ms buckets onto ${targetMs}ms (not a multiple)`);
  }
  const out = new Map<number, FlowBucketRow>();
  for (const r of [...rows].sort((a, b) => a.ts - b.ts)) {
    const ts = Math.floor(r.ts / targetMs) * targetMs;
    let acc = out.get(ts);
    if (!acc) {
      acc = emptyBucket(r.underlying, r.sessionDate, targetMs, ts);
      out.set(ts, acc);
    }
    acc.prints += r.prints;
    acc.cancels += r.cancels;
    acc.sided += r.sided;
    acc.unsided += r.unsided;
    acc.buyVolume += r.buyVolume;
    acc.sellVolume += r.sellVolume;
    acc.callPremiumBuy = round(acc.callPremiumBuy + r.callPremiumBuy, 2);
    acc.callPremiumSell = round(acc.callPremiumSell + r.callPremiumSell, 2);
    acc.putPremiumBuy = round(acc.putPremiumBuy + r.putPremiumBuy, 2);
    acc.putPremiumSell = round(acc.putPremiumSell + r.putPremiumSell, 2);
    acc.directionalDelta = round(acc.directionalDelta + r.directionalDelta, 4);
    acc.deltaFromChain += r.deltaFromChain;
    acc.deltaFromBlackScholes += r.deltaFromBlackScholes;
    acc.deltaMissing += r.deltaMissing;
    if (r.spotOpen !== null && r.spotHigh !== null && r.spotLow !== null) {
      if (acc.spotOpen === null) {
        acc.spotOpen = r.spotOpen;
        acc.spotHigh = r.spotHigh;
        acc.spotLow = r.spotLow;
      } else {
        acc.spotHigh = Math.max(acc.spotHigh ?? r.spotHigh, r.spotHigh);
        acc.spotLow = Math.min(acc.spotLow ?? r.spotLow, r.spotLow);
      }
      acc.spotClose = r.spotClose;
      acc.spotObservations += r.spotObservations;
    }
  }
  return [...out.values()].sort((a, b) => a.ts - b.ts);
}

/** Derived + cumulative series over one session's buckets (ascending ts expected). */
export function flowSeriesPayload(
  underlying: string,
  sessionDate: string,
  rows: FlowBucketRow[],
  bucketMs: number,
): FlowSeriesPayload {
  const sorted = [...rows].sort((a, b) => a.ts - b.ts);
  const totals: FlowSeriesTotals = {
    prints: 0,
    cancels: 0,
    sided: 0,
    unsided: 0,
    callNet: 0,
    putNet: 0,
    netPremium: 0,
    directionalDelta: 0,
    netVolume: 0,
    deltaFromChain: 0,
    deltaFromBlackScholes: 0,
    deltaMissing: 0,
    spotObservations: 0,
  };
  const buckets: FlowSeriesPoint[] = [];
  for (const r of sorted) {
    const callNet = round(r.callPremiumBuy - r.callPremiumSell, 2);
    const putNet = round(r.putPremiumBuy - r.putPremiumSell, 2);
    const netPremium = round(callNet - putNet, 2);
    const netVolume = r.buyVolume - r.sellVolume;
    totals.prints += r.prints;
    totals.cancels += r.cancels;
    totals.sided += r.sided;
    totals.unsided += r.unsided;
    totals.callNet = round(totals.callNet + callNet, 2);
    totals.putNet = round(totals.putNet + putNet, 2);
    totals.netPremium = round(totals.netPremium + netPremium, 2);
    totals.directionalDelta = round(totals.directionalDelta + r.directionalDelta, 4);
    totals.netVolume += netVolume;
    totals.deltaFromChain += r.deltaFromChain;
    totals.deltaFromBlackScholes += r.deltaFromBlackScholes;
    totals.deltaMissing += r.deltaMissing;
    totals.spotObservations += r.spotObservations;
    buckets.push({
      ...r,
      callNet,
      putNet,
      netPremium,
      netVolume,
      cumCallNet: totals.callNet,
      cumPutNet: totals.putNet,
      cumNetPremium: totals.netPremium,
      cumDirectionalDelta: totals.directionalDelta,
      cumNetVolume: totals.netVolume,
    });
  }
  return {
    underlying: underlying.toUpperCase(),
    sessionDate,
    bucketMs,
    buckets,
    totals,
    deltaSource: describeDeltaSource(totals),
    note: FLOW_SERIES_NOTE,
  };
}

/** One sentence saying where every plotted delta actually came from. */
export function describeDeltaSource(t: {
  deltaFromChain: number;
  deltaFromBlackScholes: number;
  deltaMissing: number;
  sided: number;
}): string {
  if (t.sided === 0) return "no sided prints yet, so no delta was derived";
  const parts: string[] = [];
  if (t.deltaFromChain > 0) {
    parts.push(`${t.deltaFromChain} print(s) used the chain snapshot's greeks`);
  }
  if (t.deltaFromBlackScholes > 0) {
    parts.push(
      `${t.deltaFromBlackScholes} print(s) used Black-Scholes delta from the print's own NBBO mid (IV solved), spot, strike, and time to expiry`,
    );
  }
  if (t.deltaMissing > 0) {
    parts.push(`${t.deltaMissing} sided print(s) had no derivable delta and were excluded`);
  }
  return `${parts.join("; ")}. A tape replay has no chain snapshot, so it derives every delta with Black-Scholes; runs that used chain greeks state so here.`;
}

/** An equity-style bar built from the spot tape (see FLOW_SERIES_NOTE). */
export interface SpotTapeBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Prints that observed a spot inside the bar — a tape density, not share volume. */
  observations: number;
}

/**
 * Spot-tape bars at a timeframe (a multiple of the buckets' width). Buckets
 * with no spot observation contribute nothing; a bar exists only where the
 * tape actually printed.
 */
export function spotBarsFromBuckets(rows: FlowBucketRow[], timeframeMs: number): SpotTapeBar[] {
  const out: SpotTapeBar[] = [];
  for (const r of [...rows].sort((a, b) => a.ts - b.ts)) {
    if (r.spotOpen === null || r.spotHigh === null || r.spotLow === null || r.spotClose === null) {
      continue;
    }
    const ts = Math.floor(r.ts / timeframeMs) * timeframeMs;
    const last = out[out.length - 1];
    if (last && last.ts === ts) {
      last.high = Math.max(last.high, r.spotHigh);
      last.low = Math.min(last.low, r.spotLow);
      last.close = r.spotClose;
      last.observations += r.spotObservations;
    } else {
      out.push({
        ts,
        open: r.spotOpen,
        high: r.spotHigh,
        low: r.spotLow,
        close: r.spotClose,
        observations: r.spotObservations,
      });
    }
  }
  return out;
}

/** Chain-snapshot greeks as a DeltaLookup: contract → delta when the snapshot carries one. */
export function deltaLookupFromChains(
  snapshots: Iterable<{
    contracts: Array<{ contract: string; greeks?: { delta?: number | null } | null }>;
  }>,
): DeltaLookup {
  const byContract = new Map<string, number>();
  for (const snap of snapshots) {
    for (const c of snap.contracts) {
      const d = c.greeks?.delta;
      if (d !== null && d !== undefined && Number.isFinite(d)) byContract.set(c.contract, d);
    }
  }
  return (tick) => byContract.get(tick.contract) ?? null;
}
