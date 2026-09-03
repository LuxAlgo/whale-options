/*
  Gamma exposure (GEX). Per strike: dollar gamma per 1% spot move =
  Γ × OI × 100 × S² × 0.01. Sign convention is an assumption, not a fact —
  the default assumes dealers are long calls and short puts (calls positive,
  puts negative), it is configurable, and every output states which
  convention produced it. Zero-gamma is found by re-evaluating net gamma
  across a spot scan (IV held fixed per contract) and interpolating the sign
  change — stated as the method in the output.
*/

import type { ChainSnapshot, GexLadder, GexPricing } from "../types.js";
import { easternTimeToUtc } from "../util/session.js";
import { blackScholes } from "./black-scholes.js";
import { solveIv } from "./brent.js";

export interface GexOptions {
  r: number;
  q: number;
  convention: "dealer-long-calls-short-puts" | "dealer-short-calls-long-puts";
  /** Restrict to one expiry (ISO date); default: all expiries in the snapshot. */
  expiry?: string;
  /** Spot-scan half-width for the zero-gamma search, as a fraction of spot. */
  scanWidth?: number;
  scanSteps?: number;
  /**
   * Re-price the snapshot's chain at this spot instead of the snapshot's own —
   * the live ladder between chain refreshes. OI/IV/greeks stay as snapshotted;
   * the output's `pricing` says so. Ignored when not a positive finite number.
   */
  spot?: number;
  /** When the override spot was observed (epoch ms); stated in the pricing note. */
  repricedTs?: number;
}

/** The provenance line every GEX payload carries. */
export function gexPricing(snapshot: ChainSnapshot, opts: GexOptions): GexPricing | null {
  const override =
    opts.spot !== undefined && Number.isFinite(opts.spot) && opts.spot > 0 ? opts.spot : null;
  const spot = override ?? snapshot.spot;
  if (spot === null || spot <= 0) return null;
  const chainIso = new Date(snapshot.ts).toISOString();
  if (override === null) {
    return {
      chainTs: snapshot.ts,
      spot,
      spotSource: "chain-snapshot",
      repricedTs: null,
      note: `chain as of ${chainIso}, priced at the snapshot's own spot ${spot}`,
    };
  }
  const repricedTs = opts.repricedTs ?? snapshot.ts;
  return {
    chainTs: snapshot.ts,
    spot,
    spotSource: "override",
    repricedTs,
    note: `chain as of ${chainIso}, re-priced at spot ${spot} at ${new Date(repricedTs).toISOString()} (OI, IV, and feed greeks are still the snapshot's)`,
  };
}

const YEAR_MS = 365 * 86_400_000;

interface PricedContract {
  strike: number;
  right: "C" | "P";
  oi: number;
  tau: number;
  iv: number;
}

export function computeGex(snapshot: ChainSnapshot, opts: GexOptions): GexLadder | null {
  const pricing = gexPricing(snapshot, opts);
  if (!pricing) return null;
  const spot = pricing.spot;
  const sign = opts.convention === "dealer-long-calls-short-puts" ? 1 : -1;
  const expiries = new Set<string>();
  const priced: PricedContract[] = [];
  let skipped = 0;

  for (const c of snapshot.contracts) {
    if (opts.expiry && c.expiry !== opts.expiry) continue;
    const oi = c.oi ?? 0;
    if (oi <= 0) continue;
    const tau = Math.max(0, (easternTimeToUtc(c.expiry, 16) - snapshot.ts) / YEAR_MS);
    if (tau <= 0) continue;
    let iv = c.iv ?? null;
    if (iv === null || !(iv > 0)) {
      const mid =
        c.nbbo && c.nbbo.bid >= 0 && c.nbbo.ask > 0 ? (c.nbbo.bid + c.nbbo.ask) / 2 : null;
      iv =
        mid !== null
          ? solveIv({
              targetPrice: mid,
              spot,
              strike: c.strike,
              tau,
              r: opts.r,
              q: opts.q,
              right: c.right,
            })
          : null;
    }
    if (iv === null || !(iv > 0)) {
      // A feed-provided gamma still counts even without IV, but only at the
      // current spot — such contracts join the ladder, not the spot scan.
      const feedGamma = c.greeks?.gamma ?? null;
      if (feedGamma === null || !Number.isFinite(feedGamma)) {
        skipped++;
        continue;
      }
      priced.push({ strike: c.strike, right: c.right, oi, tau, iv: Number.NaN });
      continue;
    }
    expiries.add(c.expiry);
    priced.push({ strike: c.strike, right: c.right, oi, tau, iv });
  }

  if (priced.length === 0) return null;

  const gammaAt = (p: PricedContract, s: number): number => {
    if (Number.isNaN(p.iv)) return 0; // feed-gamma-only contracts skip the scan
    return blackScholes({
      spot: s,
      strike: p.strike,
      tau: p.tau,
      iv: p.iv,
      r: opts.r,
      q: opts.q,
      right: p.right,
    }).gamma;
  };

  // Ladder at current spot.
  const byStrike = new Map<
    number,
    { callGex: number; putGex: number; callOi: number; putOi: number }
  >();
  for (const p of priced) {
    const gamma = gammaAt(p, spot);
    const dollar = gamma * p.oi * 100 * spot * spot * 0.01;
    const row = byStrike.get(p.strike) ?? { callGex: 0, putGex: 0, callOi: 0, putOi: 0 };
    if (p.right === "C") {
      row.callGex += sign * dollar;
      row.callOi += p.oi;
    } else {
      row.putGex += -sign * dollar;
      row.putOi += p.oi;
    }
    byStrike.set(p.strike, row);
  }

  const perStrike = [...byStrike.entries()]
    .map(([strike, row]) => ({
      strike,
      callGex: round2(row.callGex),
      putGex: round2(row.putGex),
      netGex: round2(row.callGex + row.putGex),
      callOi: row.callOi,
      putOi: row.putOi,
    }))
    .sort((a, b) => a.strike - b.strike);
  const totalGex = round2(perStrike.reduce((acc, r) => acc + r.netGex, 0));

  // Zero-gamma: net GEX as a function of spot, sign change interpolated.
  const width = opts.scanWidth ?? 0.15;
  const steps = opts.scanSteps ?? 61;
  const netAt = (s: number): number => {
    let net = 0;
    for (const p of priced) {
      const dollar = gammaAt(p, s) * p.oi * 100 * s * s * 0.01;
      net += (p.right === "C" ? sign : -sign) * dollar;
    }
    return net;
  };
  let zeroGamma: GexLadder["zeroGamma"] = null;
  let prevS = spot * (1 - width);
  let prevNet = netAt(prevS);
  for (let i = 1; i < steps; i++) {
    const s = spot * (1 - width + (2 * width * i) / (steps - 1));
    const net = netAt(s);
    if (prevNet === 0 || prevNet * net < 0) {
      const frac = prevNet === 0 ? 0 : prevNet / (prevNet - net);
      zeroGamma = {
        level: round2(prevS + frac * (s - prevS)),
        method: `spot scan ±${Math.round(width * 100)}% in ${steps} steps, linear interpolation at sign change; per-contract IV held fixed`,
      };
      break;
    }
    prevS = s;
    prevNet = net;
  }

  const conventionNote =
    opts.convention === "dealer-long-calls-short-puts"
      ? "assumes dealers are long calls and short puts: call gamma positive, put gamma negative. This is an assumption about positioning, not observed data; flip via config gexConvention."
      : "assumes dealers are short calls and long puts: call gamma negative, put gamma positive. This is an assumption about positioning, not observed data; flip via config gexConvention.";

  return {
    underlying: snapshot.underlying,
    ts: snapshot.ts,
    spot,
    convention: opts.convention,
    conventionNote,
    pricing,
    expiriesIncluded: [...expiries].sort(),
    perStrike,
    totalGex,
    zeroGamma,
    skippedContracts: skipped,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
