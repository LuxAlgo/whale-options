/*
  Normalization: RawOptionTrade (vendor-shaped) → OptionTradeTick (canonical,
  self-contained). This is the seam between "what the vendor said" and "what
  the engine reasons about": OCC parsing, condition mapping through the
  adapter's table, and enrichment defaults all happen here, exactly once.
*/

import type { RawOptionTrade } from "../feeds/types.js";
import { parseOcc } from "../occ.js";
import type { FeedId, NormalizedCondition, OptionTradeTick } from "../types.js";

export interface NormalizeResult {
  tick: OptionTradeTick | null;
  /** Why the raw print was dropped, when it was. */
  dropped?: string;
}

export function normalizeTrade(
  raw: RawOptionTrade & { seq?: number },
  feedId: FeedId,
  seq: number,
  normalizeCondition: (code: string) => NormalizedCondition,
): NormalizeResult {
  const contract = parseOcc(raw.contract);
  if (!contract) return { tick: null, dropped: `unparseable contract symbol: ${raw.contract}` };
  if (!Number.isFinite(raw.price) || raw.price <= 0) {
    return { tick: null, dropped: `non-positive price on ${raw.contract}` };
  }
  if (!Number.isFinite(raw.size) || raw.size <= 0) {
    return { tick: null, dropped: `non-positive size on ${raw.contract}` };
  }

  const conditions: NormalizedCondition[] =
    raw.conditions.length === 0 ? ["regular"] : dedupe(raw.conditions.map(normalizeCondition));

  return {
    tick: {
      seq: raw.seq ?? seq,
      ts: raw.ts,
      underlying: contract.underlying,
      contract: contract.occ,
      expiry: contract.expiry,
      strike: contract.strike,
      right: contract.right,
      price: raw.price,
      size: Math.round(raw.size),
      exchange: raw.exchange || "?",
      conditions,
      nbbo: raw.nbbo ?? null,
      spot: raw.spot ?? null,
      oi: raw.oi ?? null,
      feedId,
    },
  };
}

function dedupe(conditions: NormalizedCondition[]): NormalizedCondition[] {
  return [...new Set(conditions)];
}
