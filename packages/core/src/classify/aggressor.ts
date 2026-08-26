/*
  Aggressor-side inference: trade price vs the NBBO captured at print time.
  At/above ask ⇒ buy-aggressive, at/below bid ⇒ sell-aggressive, between ⇒
  mid. No NBBO, a stale NBBO, or a condition that voids the timestamp ⇒
  "unknown" — never guessed. The NBBO used is stored on the tick; that is the
  flight-recorder guarantee.
*/
import type { ConditionPolicy } from "../conditions.js";
import type { OptionTradeTick, Side } from "../types.js";

const EPS = 1e-9;

export interface AggressorResult {
  side: Side;
  /** Printed strictly through the quote (above ask / below bid). */
  throughQuote: boolean;
  reason: string;
}

export function inferAggressor(
  tick: OptionTradeTick,
  policy: ConditionPolicy,
  nbboStaleMs: number,
): AggressorResult {
  if (policy.forceUnknownSide) {
    return {
      side: "unknown",
      throughQuote: false,
      reason: "aggressor unknown: print-time NBBO not trustworthy for this sale condition",
    };
  }
  const nbbo = tick.nbbo;
  if (!nbbo) {
    return { side: "unknown", throughQuote: false, reason: "aggressor unknown: no NBBO on print" };
  }
  const age = tick.ts - nbbo.ts;
  if (age > nbboStaleMs || age < -1000) {
    return {
      side: "unknown",
      throughQuote: false,
      reason: `aggressor unknown: NBBO ${age}ms from print exceeds staleness bound ${nbboStaleMs}ms`,
    };
  }
  const fmt = (side: string, vs: string) =>
    `aggressor ${side}: ${tick.price} ${vs} (nbbo ${nbbo.bid}×${nbbo.ask}, ${Math.max(0, age)}ms old)`;
  if (tick.price >= nbbo.ask - EPS) {
    const through = tick.price > nbbo.ask + EPS;
    return {
      side: "buy",
      throughQuote: through,
      reason: fmt("buy", through ? `above ask ${nbbo.ask}` : `at ask ${nbbo.ask}`),
    };
  }
  if (tick.price <= nbbo.bid + EPS) {
    const through = tick.price < nbbo.bid - EPS;
    return {
      side: "sell",
      throughQuote: through,
      reason: fmt("sell", through ? `below bid ${nbbo.bid}` : `at bid ${nbbo.bid}`),
    };
  }
  return {
    side: "mid",
    throughQuote: false,
    reason: fmt("mid", `between ${nbbo.bid}×${nbbo.ask}`),
  };
}
