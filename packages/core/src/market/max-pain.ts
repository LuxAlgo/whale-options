/*
  Max pain. For each expiry, the candidate settlement price (evaluated at
  every listed strike) that minimizes the total intrinsic value option
  holders would collect at expiration, weighted by open interest:

    payout(S) = Σ_calls OI × max(0, S − K) × 100 + Σ_puts OI × max(0, K − S) × 100

  The minimizing S is the "max pain" strike. It is a static computed from
  current OI — a description of where expiring would pay holders least —
  NOT a prediction of where price will go, and that caveat ships in every
  result's `note`. Reads the latest chain snapshot; falls back to the latest
  contract_daily session when no snapshot exists.
*/

import type { FlightRecorder } from "../store/types.js";
import { round } from "../util/session.js";

export const MAX_PAIN_NOTE =
  "max pain is the strike minimizing total intrinsic value paid to option holders at " +
  "expiration, OI-weighted (payout(S) = Σ calls OI×max(0,S−K)×100 + Σ puts OI×max(0,K−S)×100, " +
  "evaluated at each listed strike); a static computed from current open interest, " +
  "not a prediction of where price will go";

export interface MaxPainExpiry {
  expiry: string;
  /** Listed strike with the lowest total holder payout (ties: lowest strike). */
  maxPainStrike: number;
  /** Total intrinsic value paid to holders if settlement were at maxPainStrike, in dollars. */
  totalPayoutAtStrike: number;
  callOi: number;
  putOi: number;
  strikesEvaluated: number;
  spot: number | null;
  note: string;
}

export interface MaxPainResult {
  underlying: string;
  /** Where the OI came from; null when the store holds neither. */
  source: "chain-snapshot" | "contract-daily" | null;
  /** Snapshot timestamp (epoch ms) when source is a chain snapshot. */
  asOfTs: number | null;
  /** Session date when source is contract_daily. */
  sessionDate: string | null;
  spot: number | null;
  expiries: MaxPainExpiry[];
  note: string;
}

interface OiLeg {
  expiry: string;
  strike: number;
  right: "C" | "P";
  oi: number;
}

export function maxPain(store: FlightRecorder, underlying: string, expiry?: string): MaxPainResult {
  const symbol = underlying.toUpperCase();
  const base: Omit<MaxPainResult, "expiries" | "note"> = {
    underlying: symbol,
    source: null,
    asOfTs: null,
    sessionDate: null,
    spot: null,
  };

  let legs: OiLeg[] = [];
  const snapshot = store.getChainSnapshot(symbol);
  if (snapshot && snapshot.contracts.length > 0) {
    base.source = "chain-snapshot";
    base.asOfTs = snapshot.ts;
    base.spot = snapshot.spot;
    legs = snapshot.contracts
      .filter((c) => c.oi !== null && c.oi !== undefined && c.oi > 0)
      .map((c) => ({ expiry: c.expiry, strike: c.strike, right: c.right, oi: c.oi as number }));
  } else {
    const dates = store.contractDailySessionDates(symbol);
    const last = dates.at(-1);
    if (last !== undefined) {
      base.source = "contract-daily";
      base.sessionDate = last;
      base.spot = store.getUnderlyingDaily(symbol).at(-1)?.spotClose ?? null;
      legs = store
        .getContractDailyByUnderlying(symbol, last)
        .filter((r) => r.oi !== null && r.oi > 0)
        .map((r) => ({ expiry: r.expiry, strike: r.strike, right: r.right, oi: r.oi as number }));
    }
  }

  if (base.source === null) {
    return {
      ...base,
      expiries: [],
      note:
        `no chain snapshot or daily contract history for ${symbol}; ` +
        "run the engine with it in universe.underlyings, or `whale backfill`",
    };
  }
  if (expiry) legs = legs.filter((l) => l.expiry === expiry);

  const byExpiry = new Map<string, OiLeg[]>();
  for (const leg of legs) {
    const list = byExpiry.get(leg.expiry) ?? [];
    list.push(leg);
    byExpiry.set(leg.expiry, list);
  }

  const expiries: MaxPainExpiry[] = [];
  for (const [exp, expLegs] of [...byExpiry.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const strikes = [...new Set(expLegs.map((l) => l.strike))].sort((a, b) => a - b);
    let bestStrike = strikes[0]!;
    let bestPayout = Number.POSITIVE_INFINITY;
    for (const s of strikes) {
      let payout = 0;
      for (const l of expLegs) {
        const intrinsic = l.right === "C" ? Math.max(0, s - l.strike) : Math.max(0, l.strike - s);
        payout += l.oi * intrinsic * 100;
      }
      if (payout < bestPayout) {
        bestPayout = payout;
        bestStrike = s;
      }
    }
    expiries.push({
      expiry: exp,
      maxPainStrike: bestStrike,
      totalPayoutAtStrike: round(bestPayout, 2),
      callOi: expLegs.reduce((acc, l) => acc + (l.right === "C" ? l.oi : 0), 0),
      putOi: expLegs.reduce((acc, l) => acc + (l.right === "P" ? l.oi : 0), 0),
      strikesEvaluated: strikes.length,
      spot: base.spot,
      note: MAX_PAIN_NOTE,
    });
  }

  return {
    ...base,
    expiries,
    note:
      expiries.length > 0
        ? MAX_PAIN_NOTE
        : expiry
          ? `no open interest recorded for ${symbol} ${expiry}; check the expiry date against the recorded chain`
          : `chain data for ${symbol} carries no open interest; nothing to weight`,
  };
}
