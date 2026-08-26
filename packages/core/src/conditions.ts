/*
  Sale-condition policy — the quiet half of the "open secret sauce".

  OPRA sale conditions arrive vendor-encoded; adapters map their codes onto
  the NormalizedCondition vocabulary and this table decides what each print
  may do. Getting this right is what separates a credible flow engine from a
  noise machine: spread legs and cancels are the classic false-positive
  source in retail flow tools, and late/out-of-sequence reports carry
  timestamps you must not trust for aggressor inference or sweep windows.
*/
import type { NormalizedCondition } from "./types.js";

export interface ConditionPolicy {
  /** May this print become a scored FlowEvent at all? */
  scoreEligible: boolean;
  /** May it join a multi-exchange sweep window? */
  sweepEligible: boolean;
  /** May it be flagged as a block on size alone? */
  blockEligible: boolean;
  /** Does it count toward contract day volume (and baselines)? */
  countsVolume: boolean;
  /** Force aggressor side to "unknown" (print-time NBBO not trustworthy). */
  forceUnknownSide: boolean;
}

const POLICIES: Record<NormalizedCondition, ConditionPolicy> = {
  regular: {
    scoreEligible: true,
    sweepEligible: true,
    blockEligible: true,
    countsVolume: true,
    forceUnknownSide: false,
  },
  iso: {
    scoreEligible: true,
    sweepEligible: true,
    blockEligible: true,
    countsVolume: true,
    forceUnknownSide: false,
  },
  auto: {
    scoreEligible: true,
    sweepEligible: true,
    blockEligible: true,
    countsVolume: true,
    forceUnknownSide: false,
  },
  // Multi-leg strategy legs print real volume but are not directional flow.
  "spread-leg": {
    scoreEligible: false,
    sweepEligible: false,
    blockEligible: false,
    countsVolume: true,
    forceUnknownSide: false,
  },
  "spread-leg-equity": {
    scoreEligible: false,
    sweepEligible: false,
    blockEligible: false,
    countsVolume: true,
    forceUnknownSide: false,
  },
  auction: {
    scoreEligible: false,
    sweepEligible: false,
    blockEligible: false,
    countsVolume: true,
    forceUnknownSide: true,
  },
  cross: {
    scoreEligible: false,
    sweepEligible: false,
    blockEligible: false,
    countsVolume: true,
    forceUnknownSide: true,
  },
  // Floor trades are legitimate blocks but report slowly and never sweep.
  floor: {
    scoreEligible: true,
    sweepEligible: false,
    blockEligible: true,
    countsVolume: true,
    forceUnknownSide: false,
  },
  cancel: {
    scoreEligible: false,
    sweepEligible: false,
    blockEligible: false,
    countsVolume: false,
    forceUnknownSide: true,
  },
  // Late/out-of-sequence: size still matters (late-reported blocks are a real
  // signal) but the timestamp is unreliable — no sweeps, no side inference.
  late: {
    scoreEligible: true,
    sweepEligible: false,
    blockEligible: true,
    countsVolume: true,
    forceUnknownSide: true,
  },
  "out-of-sequence": {
    scoreEligible: true,
    sweepEligible: false,
    blockEligible: true,
    countsVolume: true,
    forceUnknownSide: true,
  },
  reopening: {
    scoreEligible: false,
    sweepEligible: false,
    blockEligible: false,
    countsVolume: true,
    forceUnknownSide: true,
  },
  // Unmapped vendor codes stay eligible (dropping unknowns silently would bias
  // the tape) but every event built on one carries a reason flag.
  unknown: {
    scoreEligible: true,
    sweepEligible: true,
    blockEligible: true,
    countsVolume: true,
    forceUnknownSide: false,
  },
};

/**
 * Combine the policies of every condition on a print: a print is only as
 * eligible as its most restrictive condition.
 */
export function policyFor(conditions: NormalizedCondition[]): ConditionPolicy {
  if (conditions.length === 0) return POLICIES.regular;
  const merged: ConditionPolicy = { ...POLICIES.regular };
  for (const c of conditions) {
    const p = POLICIES[c] ?? POLICIES.unknown;
    merged.scoreEligible &&= p.scoreEligible;
    merged.sweepEligible &&= p.sweepEligible;
    merged.blockEligible &&= p.blockEligible;
    merged.countsVolume &&= p.countsVolume;
    merged.forceUnknownSide ||= p.forceUnknownSide;
  }
  return merged;
}

export function isCancel(conditions: NormalizedCondition[]): boolean {
  return conditions.includes("cancel");
}

export function isSpreadLeg(conditions: NormalizedCondition[]): boolean {
  return conditions.includes("spread-leg") || conditions.includes("spread-leg-equity");
}

export function hasIso(conditions: NormalizedCondition[]): boolean {
  return conditions.includes("iso");
}

/** OPRA participant exchange ids → venue names, for display and docs. */
export const EXCHANGES: Record<string, string> = {
  A: "NYSE American",
  B: "BOX",
  C: "Cboe",
  D: "MIAX Emerald",
  E: "Cboe EDGX",
  H: "MIAX Pearl",
  I: "ISE",
  J: "ISE Gemini",
  M: "MIAX",
  N: "NYSE Arca",
  O: "OPRA",
  P: "MIAX Sapphire",
  Q: "Nasdaq",
  T: "Nasdaq BX",
  W: "Cboe C2",
  X: "Nasdaq PHLX",
  Z: "Cboe BZX",
};
