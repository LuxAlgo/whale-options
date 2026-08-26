import { describe, expect, it } from "vitest";
import { computeScore, type ScoreInputs } from "../src/score/score.js";
import { testConfig } from "./helpers.js";

const cfg = testConfig().score;

function inputs(overrides: Partial<ScoreInputs> = {}): ScoreInputs {
  return {
    kind: "sweep",
    side: "buy",
    premium: 250_000,
    dte: 4,
    otmPct: 0.06,
    throughQuote: true,
    iso: true,
    dayVolume: 12_000,
    avgDailyVolume: 1_500,
    coverageDays: 20,
    premiumPercentile: 0.992,
    premiumSamples: 40_000,
    oi: 8_000,
    repetitionContract: 3,
    repetitionUnderlying: 6,
    ...overrides,
  };
}

describe("whale score", () => {
  it("scores an aggressive outlier high, with every component decomposed", () => {
    const score = computeScore(cfg, inputs());
    expect(score.total).toBeGreaterThan(70);
    expect(score.total).toBeLessThanOrEqual(100);
    expect(score.missing).toEqual([]);
    expect(score.coldStart).toBe(false);
    // The transparency contract: weighted contributions sum to the total.
    const sum = Object.values(score.components).reduce((acc, c) => acc + (c.weighted ?? 0), 0);
    expect(sum).toBeCloseTo(score.total, 1);
    // Raw inputs always ride along.
    expect(score.components.volumeVsBaseline.raw.multiple).toBeDefined();
    expect(score.components.volOi.raw.openingFlowLikely).toBe("yes");
    expect(score.components.aggression.raw.isoCorroborated).toBe("yes");
  });

  it("renormalizes weights when inputs are missing, and lists them", () => {
    const score = computeScore(
      cfg,
      inputs({ avgDailyVolume: null, oi: null, premiumPercentile: null, premiumSamples: 0 }),
    );
    expect(score.missing.sort()).toEqual(["premiumVsBaseline", "volOi", "volumeVsBaseline"]);
    for (const name of score.missing) {
      expect(score.components[name].value).toBeNull();
      expect(score.components[name].weighted).toBeNull();
      expect(score.components[name].note).toBeTruthy();
    }
    const sum = Object.values(score.components).reduce((acc, c) => acc + (c.weighted ?? 0), 0);
    expect(sum).toBeCloseTo(score.total, 1);
    // Aggression alone (weight .2 of the remaining .45) can now reach far
    // higher than its nominal 20 points — renormalization at work.
    expect(score.components.aggression.weighted ?? 0).toBeGreaterThan(20);
  });

  it("flags cold start below minBaselineDays", () => {
    expect(computeScore(cfg, inputs({ coverageDays: 2 })).coldStart).toBe(true);
    expect(computeScore(cfg, inputs({ coverageDays: 5 })).coldStart).toBe(false);
  });

  it("scores passive mid prints far below aggressive sweeps", () => {
    const aggressive = computeScore(cfg, inputs());
    const passive = computeScore(
      cfg,
      inputs({
        kind: "print",
        side: "mid",
        throughQuote: false,
        iso: false,
        dayVolume: 900,
        premiumPercentile: 0.4,
        repetitionContract: 0,
        repetitionUnderlying: 0,
      }),
    );
    expect(passive.total).toBeLessThan(aggressive.total - 25);
  });

  it("urgency degrades gracefully when spot is unknown", () => {
    const score = computeScore(cfg, inputs({ otmPct: null }));
    expect(score.components.urgency.value).not.toBeNull();
    expect(score.components.urgency.note).toContain("spot unknown");
    expect(score.missing).not.toContain("urgency");
  });
});
