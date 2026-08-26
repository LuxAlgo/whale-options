/*
  The whale score — weighted, transparent, every component reported.

  The industry sells this number as proprietary detection; here it is six
  documented components, each with its raw inputs attached to every event.
  Components whose inputs are unavailable go null, get listed in `missing`,
  and the remaining weights renormalize — the score never silently pretends
  it knew something it didn't.
*/

import type { WhaleConfig } from "../config.js";
import type { EventKind, ScoreComponent, ScoreComponentName, Side, WhaleScore } from "../types.js";
import { round } from "../util/session.js";

export interface ScoreInputs {
  kind: EventKind;
  side: Side;
  premium: number;
  dte: number;
  otmPct: number | null;
  throughQuote: boolean;
  iso: boolean;
  /** Contract day volume including this event's legs. */
  dayVolume: number;
  avgDailyVolume: number | null;
  coverageDays: number;
  /** Percentile (0..1) of this premium in the underlying's distribution. */
  premiumPercentile: number | null;
  premiumSamples: number;
  oi: number | null;
  /** Prior same-side scored events this session, before this one. */
  repetitionContract: number;
  repetitionUnderlying: number;
}

type ScoreCfg = WhaleConfig["score"];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function computeScore(cfg: ScoreCfg, inputs: ScoreInputs): WhaleScore {
  const components = {} as Record<ScoreComponentName, ScoreComponent>;

  // 1. volumeVsBaseline — day volume as a log-scaled multiple of its own 20d average.
  {
    const avg = inputs.avgDailyVolume;
    if (avg === null || avg <= 0) {
      components.volumeVsBaseline = miss(
        cfg.weights.volumeVsBaseline,
        "no volume baseline for this contract yet",
        {
          dayVolume: inputs.dayVolume,
          avgDailyVolume: avg,
        },
      );
    } else {
      const multiple = inputs.dayVolume / avg;
      const value = clamp01(Math.log(Math.max(1, multiple)) / Math.log(cfg.caps.volumeMult));
      components.volumeVsBaseline = comp(value, cfg.weights.volumeVsBaseline, {
        dayVolume: inputs.dayVolume,
        avgDailyVolume: round(avg, 1),
        multiple: round(multiple, 2),
        capMultiple: cfg.caps.volumeMult,
      });
    }
  }
  if (inputs.premiumPercentile === null || inputs.premiumSamples < cfg.minPremiumSamples) {
    components.premiumVsBaseline = miss(
      cfg.weights.premiumVsBaseline,
      `premium distribution too thin (${inputs.premiumSamples}/${cfg.minPremiumSamples} samples)`,
      { premium: round(inputs.premium, 2), samples: inputs.premiumSamples },
    );
  } else {
    components.premiumVsBaseline = comp(
      clamp01(inputs.premiumPercentile),
      cfg.weights.premiumVsBaseline,
      {
        premium: round(inputs.premium, 2),
        percentile: round(inputs.premiumPercentile, 4),
        samples: inputs.premiumSamples,
      },
    );
  }
  if (inputs.oi === null || inputs.oi <= 0) {
    components.volOi = miss(cfg.weights.volOi, "open interest unavailable", {
      dayVolume: inputs.dayVolume,
      oi: inputs.oi,
    });
  } else {
    const ratio = inputs.dayVolume / inputs.oi;
    const value = clamp01(Math.log2(1 + ratio) / Math.log2(1 + cfg.caps.volOi));
    components.volOi = comp(value, cfg.weights.volOi, {
      dayVolume: inputs.dayVolume,
      oi: inputs.oi,
      ratio: round(ratio, 3),
      capRatio: cfg.caps.volOi,
      openingFlowLikely: ratio > 1 ? "yes" : "no",
    });
  }

  // 4. aggression — how the print(s) hit the quote, plus sweep/ISO corroboration.
  {
    const a = cfg.aggression;
    let value: number;
    let note: string | undefined;
    if (inputs.side === "unknown") {
      value = a.unknown;
      note = "aggressor side unknown";
    } else if (inputs.side === "mid") {
      value = a.mid;
    } else {
      value = inputs.throughQuote ? a.throughQuote : a.atQuote;
    }
    if (inputs.kind === "sweep") value += a.sweepBonus;
    if (inputs.iso) value += a.isoBonus;
    components.aggression = comp(
      clamp01(value),
      cfg.weights.aggression,
      {
        side: inputs.side,
        throughQuote: inputs.throughQuote ? "yes" : "no",
        kind: inputs.kind,
        isoCorroborated: inputs.iso ? "yes" : "no",
      },
      note,
    );
  }

  // 5. urgency — short DTE × OTM distance interaction.
  {
    const u = cfg.urgency;
    const dteFactor = Math.exp(-inputs.dte / u.dteTauDays);
    if (inputs.otmPct === null) {
      components.urgency = comp(
        clamp01(dteFactor * 0.4),
        cfg.weights.urgency,
        {
          dte: round(inputs.dte, 2),
          dteFactor: round(dteFactor, 3),
          otmPct: null,
        },
        "spot unknown: OTM distance unavailable, DTE factor only",
      );
    } else {
      const otmFactor = clamp01(inputs.otmPct / u.otmScale);
      const value = clamp01(dteFactor * (0.4 + 0.6 * otmFactor));
      components.urgency = comp(value, cfg.weights.urgency, {
        dte: round(inputs.dte, 2),
        dteFactor: round(dteFactor, 3),
        otmPct: round(inputs.otmPct, 4),
        otmFactor: round(otmFactor, 3),
      });
    }
  }

  // 6. repetition — same-direction repeat hits this session.
  {
    const hits = inputs.repetitionContract + 0.5 * inputs.repetitionUnderlying;
    const value = clamp01(Math.log2(1 + hits) / Math.log2(1 + cfg.caps.repetition));
    components.repetition = comp(value, cfg.weights.repetition, {
      contractHits: inputs.repetitionContract,
      underlyingHits: inputs.repetitionUnderlying,
      weightedHits: round(hits, 1),
      capHits: cfg.caps.repetition,
    });
  }

  // Weighted total over available components, renormalized, scaled 0..100.
  const names = Object.keys(components) as ScoreComponentName[];
  const active = names.filter((n) => components[n].value !== null);
  const missing = names.filter((n) => components[n].value === null);
  const weightSum = active.reduce((acc, n) => acc + components[n].weight, 0);
  let total = 0;
  for (const n of names) {
    const c = components[n];
    if (c.value === null || weightSum === 0) {
      c.weighted = null;
      continue;
    }
    c.weighted = round((c.value * c.weight * 100) / weightSum, 2);
    total += c.weighted;
  }

  return {
    total: round(total, 1),
    components,
    missing,
    baselineDays: inputs.coverageDays,
    coldStart: inputs.coverageDays < cfg.minBaselineDays,
  };
}

function comp(
  value: number,
  weight: number,
  raw: Record<string, number | string | null>,
  note?: string,
): ScoreComponent {
  return { value: round(value, 4), weight, weighted: null, raw, ...(note ? { note } : {}) };
}

function miss(
  weight: number,
  note: string,
  raw: Record<string, number | string | null>,
): ScoreComponent {
  return { value: null, weight, weighted: null, raw, note };
}
