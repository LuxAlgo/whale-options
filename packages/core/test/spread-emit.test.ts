/*
  engine.emit.spreadLegs — the opt-in record of strategy legs. Off by default
  (spread legs are the classic false-positive source); on, they emit as
  print/unknown events whose score is explicitly empty, never invented.
*/
import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../src/engine.js";
import { makeTick, resetSeq, T0, testConfig } from "./helpers.js";

beforeEach(resetSeq);

describe("spread-leg emission (engine.emit.spreadLegs)", () => {
  const legs = () => [
    makeTick({ ts: T0, conditions: ["spread-leg"], size: 200, exchange: "C" }),
    makeTick({
      ts: T0,
      conditions: ["spread-leg"],
      size: 200,
      exchange: "C",
      contract: { underlying: "NVDA", expiry: "2026-09-18", right: "C", strike: 210 },
    }),
  ];

  it("stays silent by default", () => {
    const engine = new Engine(testConfig());
    const out = legs().flatMap((t) => engine.push(t));
    out.push(...engine.flush());
    expect(out).toHaveLength(0);
  });

  it("emits unscored print/unknown events when enabled", () => {
    const engine = new Engine(testConfig({ engine: { emit: { spreadLegs: true } } }));
    const out = legs().flatMap((t) => engine.push(t));
    out.push(...engine.flush());
    expect(out).toHaveLength(2);
    for (const event of out) {
      expect(event.kind).toBe("print");
      expect(event.side).toBe("unknown");
      expect(event.score.total).toBe(0);
      expect(event.score.missing).toHaveLength(6);
      for (const c of Object.values(event.score.components)) {
        expect(c.value).toBeNull();
        expect(c.note).toContain("spread leg");
      }
      expect(event.reasons.join(" ")).toContain("excluded from scoring");
    }
  });

  it("respects the premium emission floor when enabled", () => {
    const engine = new Engine(
      testConfig({ engine: { emit: { spreadLegs: true, minPremium: 1_000_000 } } }),
    );
    const out = legs().flatMap((t) => engine.push(t));
    out.push(...engine.flush());
    expect(out).toHaveLength(0);
  });
});
