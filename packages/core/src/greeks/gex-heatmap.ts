/*
  Strike-by-expiry GEX heatmap: the ladder, one column per expiry. Every
  cell is computeGex restricted to that expiry, so the grid inherits the
  ladder's assumptions verbatim — the dealer-positioning sign convention,
  feed greeks or Black-Scholes gamma, IV held fixed — and its output states
  them the same way. Rows are the strikes nearest to spot (the chain's far
  wings carry little gamma and a lot of screen), with the omitted count
  reported rather than hidden.
*/

import type { ChainSnapshot, GexHeatmap } from "../types.js";
import { computeGex, type GexOptions, gexPricing } from "./gex.js";

export interface GexHeatmapOptions extends Omit<GexOptions, "expiry"> {
  /** Strike rows to keep around spot (default 21). */
  rows?: number;
}

export const GEX_HEATMAP_NOTE =
  "cells are net dollar gamma per 1% spot move (Γ × OI × 100 × S² × 0.01) for one strike and " +
  "one expiry, calls and puts netted under the stated dealer convention; strikeTotals is the " +
  "all-expiry ladder at each row, expiryTotals is each expiry's whole ladder (all strikes, " +
  "including rows not shown). Rows are the strikes nearest to spot with usable gamma; " +
  "`strikesOmitted` counts the rest. Greeks come from the feed when provided, else " +
  "Black-Scholes with IV solved from the quote mid; per-contract IV is held fixed when " +
  "re-pricing at a live spot.";

export function computeGexHeatmap(
  snapshot: ChainSnapshot,
  opts: GexHeatmapOptions,
): GexHeatmap | null {
  const pricing = gexPricing(snapshot, opts);
  if (!pricing) return null;
  const spot = pricing.spot;
  const all = computeGex(snapshot, opts);
  if (!all) return null;

  const expiries = all.expiriesIncluded;
  const perExpiry = expiries.map((expiry) => computeGex(snapshot, { ...opts, expiry }));

  // Strikes: every strike with usable gamma anywhere, then the `rows` nearest spot.
  const strikeSet = new Set<number>(all.perStrike.map((r) => r.strike));
  const rows = Math.max(1, Math.floor(opts.rows ?? 21));
  const strikes = [...strikeSet]
    .sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot) || a - b)
    .slice(0, rows)
    .sort((a, b) => a - b);
  const strikesOmitted = strikeSet.size - strikes.length;

  const cells = strikes.map((strike) =>
    perExpiry.map((ladder) => ladder?.perStrike.find((r) => r.strike === strike)?.netGex ?? 0),
  );
  const netByStrike = new Map(all.perStrike.map((r) => [r.strike, r.netGex]));
  const strikeTotals = strikes.map((k) => netByStrike.get(k) ?? 0);
  const expiryTotals = perExpiry.map((ladder) => ladder?.totalGex ?? 0);

  let spotRowIndex: number | null = null;
  for (let i = 0; i < strikes.length; i++) {
    const k = strikes[i];
    if (k === undefined) continue;
    if (
      spotRowIndex === null ||
      Math.abs(k - spot) < Math.abs((strikes[spotRowIndex] ?? k) - spot)
    ) {
      spotRowIndex = i;
    }
  }

  return {
    underlying: all.underlying,
    ts: all.ts,
    spot,
    convention: all.convention,
    conventionNote: all.conventionNote,
    pricing,
    expiries,
    strikes,
    cells,
    strikeTotals,
    expiryTotals,
    totalGex: all.totalGex,
    spotRowIndex,
    zeroGamma: all.zeroGamma,
    strikesOmitted,
    skippedContracts: all.skippedContracts,
    note: GEX_HEATMAP_NOTE,
  };
}
