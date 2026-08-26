/*
  Open-interest deltas between recorded sessions. OI settles overnight, so
  the honest unit of change is session-to-session: this compares the latest
  contract_daily rows against an earlier recorded session (default: the
  previous one) and reports per-contract, per-strike, and per-expiry deltas.
  Deltas describe what changed in the data — a rise in OI says contracts were
  opened, nothing about who opened them or why. Contracts present in the
  latest session but absent earlier are flagged `newContract` (their whole OI
  counts as the delta, with no percentage — there is no base to divide by);
  contracts that dropped out of the chain are not synthesized to zero.
*/

import type { FlightRecorder } from "../store/types.js";
import { round } from "../util/session.js";

export interface OiDeltasOptions {
  /** Compare across the last N recorded session dates (default 2: latest vs previous). */
  sessions?: number;
  /** Cap the ranked per-contract list (default 20; aggregates use all rows). */
  top?: number;
  /** Ignore contracts whose OI never reached this on either session (default 0). */
  minOi?: number;
}

export interface OiDeltaContract {
  contract: string;
  expiry: string;
  strike: number;
  right: "C" | "P";
  prevOi: number | null;
  currOi: number;
  /** currOi − prevOi; for a new contract the full currOi (base treated as 0). */
  deltaOi: number;
  /** Percent change vs prevOi; null when there is no prior base to divide by. */
  deltaPct: number | null;
  /** True when the contract has no row on the earlier session — new to the chain. */
  newContract: boolean;
}

export interface OiDeltaGroup {
  prevOi: number;
  currOi: number;
  deltaOi: number;
}

export interface OiDeltasResult {
  underlying: string;
  /** Earlier session compared against; null when history is insufficient. */
  fromDate: string | null;
  /** Latest recorded session; null when no history exists at all. */
  toDate: string | null;
  sessionsAvailable: number;
  /** Ranked by |ΔOI| descending, capped at opts.top. */
  contracts: OiDeltaContract[];
  byStrike: Array<{ strike: number } & OiDeltaGroup>;
  byExpiry: Array<{ expiry: string } & OiDeltaGroup>;
  /** Honest caveat when fewer than 2 sessions are recorded; null otherwise. */
  note: string | null;
}

export function oiDeltas(
  store: FlightRecorder,
  underlying: string,
  opts: OiDeltasOptions = {},
): OiDeltasResult {
  const symbol = underlying.toUpperCase();
  const dates = store.contractDailySessionDates(symbol);
  if (dates.length < 2) {
    return {
      underlying: symbol,
      fromDate: null,
      toDate: dates.at(-1) ?? null,
      sessionsAvailable: dates.length,
      contracts: [],
      byStrike: [],
      byExpiry: [],
      note:
        `only ${dates.length} recorded session${dates.length === 1 ? "" : "s"} of contract history ` +
        `for ${symbol}: OI deltas need daily history; run the engine across sessions or \`whale backfill\``,
    };
  }

  const sessions = Math.max(2, Math.floor(opts.sessions ?? 2));
  const fromDate = dates[Math.max(0, dates.length - sessions)]!;
  const toDate = dates.at(-1)!;
  const prevByContract = new Map(
    store.getContractDailyByUnderlying(symbol, fromDate).map((r) => [r.contract, r]),
  );
  const minOi = opts.minOi ?? 0;

  const contracts: OiDeltaContract[] = [];
  for (const row of store.getContractDailyByUnderlying(symbol, toDate)) {
    if (row.oi === null) continue; // no OI recorded — nothing to diff
    const prev = prevByContract.get(row.contract);
    const prevOi = prev?.oi ?? null;
    if (Math.max(row.oi, prevOi ?? 0) < minOi) continue;
    const deltaOi = row.oi - (prevOi ?? 0);
    contracts.push({
      contract: row.contract,
      expiry: row.expiry,
      strike: row.strike,
      right: row.right,
      prevOi,
      currOi: row.oi,
      deltaOi,
      deltaPct: prevOi !== null && prevOi > 0 ? round((deltaOi / prevOi) * 100, 2) : null,
      newContract: prev === undefined,
    });
  }
  contracts.sort((a, b) => Math.abs(b.deltaOi) - Math.abs(a.deltaOi));

  const byStrike = aggregate(contracts, (c) => c.strike);
  const byExpiry = aggregate(contracts, (c) => c.expiry);
  return {
    underlying: symbol,
    fromDate,
    toDate,
    sessionsAvailable: dates.length,
    contracts: contracts.slice(0, opts.top ?? 20),
    byStrike: byStrike.map(([strike, g]) => ({ strike, ...g })),
    byExpiry: byExpiry.map(([expiry, g]) => ({ expiry, ...g })),
    note: null,
  };
}

/** Sum deltas per key over ALL qualifying contracts, ranked by |ΔOI| descending. */
function aggregate<K extends string | number>(
  contracts: OiDeltaContract[],
  keyOf: (c: OiDeltaContract) => K,
): Array<[K, OiDeltaGroup]> {
  const groups = new Map<K, OiDeltaGroup>();
  for (const c of contracts) {
    const key = keyOf(c);
    const g = groups.get(key) ?? { prevOi: 0, currOi: 0, deltaOi: 0 };
    g.prevOi += c.prevOi ?? 0;
    g.currOi += c.currOi;
    g.deltaOi += c.deltaOi;
    groups.set(key, g);
  }
  return [...groups.entries()].sort((a, b) => Math.abs(b[1].deltaOi) - Math.abs(a[1].deltaOi));
}
