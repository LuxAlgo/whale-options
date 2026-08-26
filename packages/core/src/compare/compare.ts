/*
  Feed cross-validation (`whale compare`): run two adapters over the same
  window and diff their tapes. Which prints one vendor missed, where the
  condition codes disagree, how the timestamps skew. Nobody hands retail an
  instrument for auditing whether a paid feed is complete — this is that
  instrument. It measures divergence; it never adjudicates blame — a print
  missing from one side of the window is evidence to raise with the vendor,
  not proof of a bad feed.

  Matching algorithm (deterministic given the same input streams):
  1. Each side's raw prints are normalized in arrival order through the
     adapter's own condition table (the collection loop never reorders).
  2. Ticks are bucketed by the exact key (contract, price, size) — a print
     can only ever match a print of the same contract at the same price and
     size; timestamps are where vendors legitimately differ.
  3. Inside each bucket, every (a, b) pair with |tsA − tsB| ≤ tolerance is a
     candidate. Candidates are sorted nearest-ts-first (ties broken by
     a.ts, then b.ts, then arrival order on each side) and taken greedily;
     each tick matches at most once.
  4. Everything left unmatched is unique to its side.

  Live comparison is wall-clock inherently (two real vendor streams over a
  shared window). For deterministic tests, feed it replay/synthetic adapters:
  same input streams ⇒ byte-identical report.
*/

import type { FeedAdapter } from "../feeds/types.js";
import { normalizeTrade } from "../normalize/normalize.js";
import type { Nbbo, NormalizedCondition } from "../types.js";

export interface CompareOptions {
  a: { id: string; adapter: FeedAdapter };
  b: { id: string; adapter: FeedAdapter };
  underlyings: string[];
  /** Collection window in wall-clock ms; replayed streams may end sooner. */
  durationMs: number;
  /** Max |tsA − tsB| for two prints to be considered the same print. */
  matchToleranceMs?: number;
  signal?: AbortSignal;
  onProgress?: (p: { feed: string; ticks: number }) => void;
}

export interface CompareSample {
  contract: string;
  ts: number;
  price: number;
  size: number;
  exchange: string;
}

export interface CompareReport {
  window: { startedAt: number; durationMs: number };
  feeds: { a: string; b: string };
  ticks: { a: number; b: number };
  matched: number;
  onlyA: number;
  onlyB: number;
  /** matched as a percentage of each side's own tick count. */
  matchedPct: { ofA: number; ofB: number };
  /** Matched pairs whose normalized condition sets differ (order-insensitive). */
  conditionDisagreements: Array<{ contract: string; ts: number; a: string[]; b: string[] }>;
  /** Fraction of each side's ticks that carried an NBBO. */
  nbboCoverage: { a: number; b: number };
  /** b.ts − a.ts over matched pairs; null when nothing matched. */
  tsSkewMs: { median: number; p95: number; min: number; max: number } | null;
  samples: { onlyA: CompareSample[]; onlyB: CompareSample[] };
  notes: string[];
}

const MAX_CONDITION_DISAGREEMENTS = 50;
const MAX_SAMPLES = 20;
const PROGRESS_EVERY = 200;

/** One normalized print plus its arrival index (the deterministic tie-break). */
interface CollectedTick {
  contract: string;
  ts: number;
  price: number;
  size: number;
  exchange: string;
  conditions: NormalizedCondition[];
  nbbo: Nbbo | null;
  idx: number;
}

interface CollectedSide {
  ticks: CollectedTick[];
  dropped: number;
}

async function collectSide(
  side: { id: string; adapter: FeedAdapter },
  underlyings: string[],
  signal: AbortSignal,
  onProgress?: (p: { feed: string; ticks: number }) => void,
): Promise<CollectedSide> {
  const ticks: CollectedTick[] = [];
  let dropped = 0;
  let seq = 0;
  try {
    for await (const raw of side.adapter.subscribeOptionTrades({ underlyings }, signal)) {
      const { tick } = normalizeTrade(raw, side.adapter.id, seq++, (code) =>
        side.adapter.normalizeCondition(code),
      );
      if (!tick) {
        dropped++;
        continue;
      }
      ticks.push({
        contract: tick.contract,
        ts: tick.ts,
        price: tick.price,
        size: tick.size,
        exchange: tick.exchange,
        conditions: tick.conditions,
        nbbo: tick.nbbo,
        idx: ticks.length,
      });
      if (onProgress && ticks.length % PROGRESS_EVERY === 0) {
        onProgress({ feed: side.id, ticks: ticks.length });
      }
    }
  } catch (err) {
    // An adapter tearing down on abort is a clean stop, not a failure.
    if (!signal.aborted) throw err;
  }
  onProgress?.({ feed: side.id, ticks: ticks.length });
  return { ticks, dropped };
}

interface MatchedPair {
  a: CollectedTick;
  b: CollectedTick;
  /** b.ts − a.ts. */
  skewMs: number;
}

interface MatchResult {
  pairs: MatchedPair[];
  onlyA: CollectedTick[];
  onlyB: CollectedTick[];
}

function byTsThenIdx(x: CollectedTick, y: CollectedTick): number {
  return x.ts - y.ts || x.idx - y.idx;
}

/** Greedy nearest-ts matching per (contract, price, size) bucket. */
function matchTicks(
  aTicks: CollectedTick[],
  bTicks: CollectedTick[],
  toleranceMs: number,
): MatchResult {
  const buckets = new Map<string, { a: CollectedTick[]; b: CollectedTick[] }>();
  const bucketFor = (t: CollectedTick) => {
    const key = `${t.contract}|${t.price}|${t.size}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { a: [], b: [] };
      buckets.set(key, bucket);
    }
    return bucket;
  };
  for (const t of aTicks) bucketFor(t).a.push(t);
  for (const t of bTicks) bucketFor(t).b.push(t);

  const pairs: MatchedPair[] = [];
  const matchedA = new Set<CollectedTick>();
  const matchedB = new Set<CollectedTick>();

  for (const bucket of buckets.values()) {
    if (bucket.a.length === 0 || bucket.b.length === 0) continue;
    bucket.a.sort(byTsThenIdx);
    bucket.b.sort(byTsThenIdx);

    // Enumerate candidates with a sliding lower bound on b — both lists are
    // ts-sorted, so each a only scans the b's inside its tolerance band.
    const candidates: Array<{ a: CollectedTick; b: CollectedTick; absSkew: number }> = [];
    let lo = 0;
    for (const a of bucket.a) {
      while (lo < bucket.b.length && (bucket.b[lo]?.ts ?? 0) < a.ts - toleranceMs) lo++;
      for (let j = lo; j < bucket.b.length; j++) {
        const b = bucket.b[j];
        if (!b) break;
        if (b.ts > a.ts + toleranceMs) break;
        candidates.push({ a, b, absSkew: Math.abs(b.ts - a.ts) });
      }
    }
    candidates.sort(
      (x, y) =>
        x.absSkew - y.absSkew ||
        x.a.ts - y.a.ts ||
        x.b.ts - y.b.ts ||
        x.a.idx - y.a.idx ||
        x.b.idx - y.b.idx,
    );
    for (const c of candidates) {
      if (matchedA.has(c.a) || matchedB.has(c.b)) continue;
      matchedA.add(c.a);
      matchedB.add(c.b);
      pairs.push({ a: c.a, b: c.b, skewMs: c.b.ts - c.a.ts });
    }
  }

  pairs.sort((x, y) => byTsThenIdx(x.a, y.a));
  const onlyA = aTicks.filter((t) => !matchedA.has(t)).sort(byTsThenIdx);
  const onlyB = bTicks.filter((t) => !matchedB.has(t)).sort(byTsThenIdx);
  return { pairs, onlyA, onlyB };
}

function conditionKey(conditions: NormalizedCondition[]): string {
  return [...conditions].sort().join(",");
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function skewStats(pairs: MatchedPair[]): CompareReport["tsSkewMs"] {
  if (pairs.length === 0) return null;
  const skews = pairs.map((p) => p.skewMs).sort((x, y) => x - y);
  const n = skews.length;
  const median = n % 2 === 1 ? skews[(n - 1) / 2]! : (skews[n / 2 - 1]! + skews[n / 2]!) / 2;
  const p95 = skews[Math.max(0, Math.ceil(0.95 * n) - 1)]!;
  return { median, p95, min: skews[0]!, max: skews[n - 1]! };
}

function toSample(t: CollectedTick): CompareSample {
  return { contract: t.contract, ts: t.ts, price: t.price, size: t.size, exchange: t.exchange };
}

/**
 * Run both adapters over the same window and diff the resulting tapes.
 * Both streams are collected concurrently until `durationMs` elapses, the
 * outer signal aborts, or both streams end on their own (replayed tapes end
 * early and that is handled gracefully — collection stops when BOTH end).
 */
export async function compareFeeds(opts: CompareOptions): Promise<CompareReport> {
  const startedAt = Date.now();
  const toleranceMs = opts.matchToleranceMs ?? 1000;

  const controllerA = new AbortController();
  const controllerB = new AbortController();
  const stopBoth = () => {
    controllerA.abort();
    controllerB.abort();
  };
  if (opts.signal?.aborted) stopBoth();
  opts.signal?.addEventListener("abort", stopBoth, { once: true });
  const timer = setTimeout(stopBoth, opts.durationMs);
  timer.unref?.();

  let a: CollectedSide;
  let b: CollectedSide;
  try {
    [a, b] = await Promise.all([
      collectSide(opts.a, opts.underlyings, controllerA.signal, opts.onProgress),
      collectSide(opts.b, opts.underlyings, controllerB.signal, opts.onProgress),
    ]);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", stopBoth);
    stopBoth();
  }

  const { pairs, onlyA, onlyB } = matchTicks(a.ticks, b.ticks, toleranceMs);

  const conditionDisagreements: CompareReport["conditionDisagreements"] = [];
  for (const pair of pairs) {
    if (conditionKey(pair.a.conditions) === conditionKey(pair.b.conditions)) continue;
    if (conditionDisagreements.length >= MAX_CONDITION_DISAGREEMENTS) break;
    conditionDisagreements.push({
      contract: pair.a.contract,
      ts: pair.a.ts,
      a: [...pair.a.conditions].sort(),
      b: [...pair.b.conditions].sort(),
    });
  }

  const nbboFraction = (ticks: CollectedTick[]) =>
    ticks.length === 0 ? 0 : round2(ticks.filter((t) => t.nbbo !== null).length / ticks.length);

  const notes = [
    `comparison covers only the subscribed underlyings (${opts.underlyings.join(", ")}) over one ${Math.round(opts.durationMs / 1000)}s window; it says nothing about coverage outside them`,
    "venue and SIP reporting paths differ between vendors; small timestamp skew on matched prints is normal, not a defect",
    "prints present on one feed and absent on the other in this window are evidence to investigate with the vendor (entitlements, condition filtering, connection health), not proof of a bad feed",
  ];
  if (a.dropped > 0 || b.dropped > 0) {
    notes.push(
      `unparseable prints were dropped before matching: ${a.dropped} from ${opts.a.id}, ${b.dropped} from ${opts.b.id}`,
    );
  }

  return {
    window: { startedAt, durationMs: opts.durationMs },
    feeds: { a: opts.a.id, b: opts.b.id },
    ticks: { a: a.ticks.length, b: b.ticks.length },
    matched: pairs.length,
    onlyA: onlyA.length,
    onlyB: onlyB.length,
    matchedPct: {
      ofA: a.ticks.length === 0 ? 100 : round2((pairs.length / a.ticks.length) * 100),
      ofB: b.ticks.length === 0 ? 100 : round2((pairs.length / b.ticks.length) * 100),
    },
    conditionDisagreements,
    nbboCoverage: { a: nbboFraction(a.ticks), b: nbboFraction(b.ticks) },
    tsSkewMs: skewStats(pairs),
    samples: {
      onlyA: onlyA.slice(0, MAX_SAMPLES).map(toSample),
      onlyB: onlyB.slice(0, MAX_SAMPLES).map(toSample),
    },
    notes,
  };
}
