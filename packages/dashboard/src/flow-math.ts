/*
  Client-side twin of the engine's flow-series derivations, so live buckets
  arriving over /ws can be folded to the chart's timeframe and accumulated
  without a round trip. Same definitions as core's flow/series.ts: callNet =
  buys − sells, netPremium = callNet − putNet (bullish-positive), netVolume =
  buy contracts − sell contracts, cumulative sums in time order.
*/
import type { FlowBucket } from "./types.js";

export interface FlowPoint {
  time: number;
  prints: number;
  callNet: number;
  putNet: number;
  netPremium: number;
  directionalDelta: number;
  netVolume: number;
  cumCallNet: number;
  cumPutNet: number;
  cumNetPremium: number;
  cumDirectionalDelta: number;
  cumNetVolume: number;
}

export interface FlowCounts {
  prints: number;
  cancels: number;
  sided: number;
  unsided: number;
  deltaFromChain: number;
  deltaFromBlackScholes: number;
  deltaMissing: number;
  spotObservations: number;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Fold 1-minute (or whatever) buckets onto `tfMs` and accumulate, ascending by time. */
export function buildFlowPoints(buckets: FlowBucket[], tfMs: number): FlowPoint[] {
  const folded = new Map<number, FlowPoint>();
  for (const b of [...buckets].sort((x, y) => x.ts - y.ts)) {
    const time = Math.floor(b.ts / tfMs) * tfMs;
    const callNet = b.callPremiumBuy - b.callPremiumSell;
    const putNet = b.putPremiumBuy - b.putPremiumSell;
    const acc = folded.get(time) ?? {
      time,
      prints: 0,
      callNet: 0,
      putNet: 0,
      netPremium: 0,
      directionalDelta: 0,
      netVolume: 0,
      cumCallNet: 0,
      cumPutNet: 0,
      cumNetPremium: 0,
      cumDirectionalDelta: 0,
      cumNetVolume: 0,
    };
    acc.prints += b.prints;
    acc.callNet = round2(acc.callNet + callNet);
    acc.putNet = round2(acc.putNet + putNet);
    acc.netPremium = round2(acc.callNet - acc.putNet);
    acc.directionalDelta += b.directionalDelta;
    acc.netVolume += b.buyVolume - b.sellVolume;
    folded.set(time, acc);
  }
  const out = [...folded.values()].sort((a, b) => a.time - b.time);
  let cumCall = 0;
  let cumPut = 0;
  let cumDelta = 0;
  let cumVol = 0;
  for (const p of out) {
    cumCall = round2(cumCall + p.callNet);
    cumPut = round2(cumPut + p.putNet);
    cumDelta += p.directionalDelta;
    cumVol += p.netVolume;
    p.cumCallNet = cumCall;
    p.cumPutNet = cumPut;
    p.cumNetPremium = round2(cumCall - cumPut);
    p.cumDirectionalDelta = cumDelta;
    p.cumNetVolume = cumVol;
  }
  return out;
}

export function flowCounts(buckets: FlowBucket[]): FlowCounts {
  const c: FlowCounts = {
    prints: 0,
    cancels: 0,
    sided: 0,
    unsided: 0,
    deltaFromChain: 0,
    deltaFromBlackScholes: 0,
    deltaMissing: 0,
    spotObservations: 0,
  };
  for (const b of buckets) {
    c.prints += b.prints;
    c.cancels += b.cancels;
    c.sided += b.sided;
    c.unsided += b.unsided;
    c.deltaFromChain += b.deltaFromChain;
    c.deltaFromBlackScholes += b.deltaFromBlackScholes;
    c.deltaMissing += b.deltaMissing;
    c.spotObservations += b.spotObservations;
  }
  return c;
}

/**
 * 04:00–20:00 ET of a session date as UTC epoch ms. The browser has a real
 * tz database, so the offset comes from Intl (display-side only — the
 * engine's own session math stays Intl-free).
 */
export function sessionBoundsUtc(session: string): { from: number; to: number } {
  const noonUtc = Date.parse(`${session}T12:00:00Z`);
  const hourInNy = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      hour12: false,
    }).format(noonUtc),
  );
  // NY hour at 12:00Z is 08 (EDT, −4) or 07 (EST, −5).
  const offsetHours = 12 - hourInNy;
  const midnightNyUtc = Date.parse(`${session}T00:00:00Z`) + offsetHours * 3_600_000;
  return { from: midnightNyUtc + 4 * 3_600_000, to: midnightNyUtc + 20 * 3_600_000 };
}
