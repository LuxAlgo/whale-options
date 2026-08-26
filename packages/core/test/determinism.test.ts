/*
  The determinism contract, proven end to end: the synthetic feed is a pure
  function of its seed, and the engine is a pure function of the tape — so
  same seed + same config ⇒ byte-identical event streams. This is the
  property `whale replay` (and every golden test) stands on.
*/
import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine.js";
import { SyntheticFeed } from "../src/feeds/synthetic.js";
import { normalizeTrade } from "../src/normalize/normalize.js";
import type { FlowEvent, OptionTradeTick } from "../src/types.js";
import { easternTimeToUtc } from "../src/util/session.js";
import { testConfig } from "./helpers.js";

const START = easternTimeToUtc("2026-08-24", 9, 30);

async function collectTicks(seed: number, maxEvents: number): Promise<OptionTradeTick[]> {
  const feed = new SyntheticFeed({
    seed,
    startTs: START,
    maxEvents,
    pace: "asap",
    regime: "mixed",
  });
  const ticks: OptionTradeTick[] = [];
  let seq = 0;
  for await (const raw of feed.subscribeOptionTrades({})) {
    const { tick } = normalizeTrade(raw, "synthetic", seq, (c) => feed.normalizeCondition(c));
    if (tick) {
      ticks.push(tick);
      seq++;
    }
  }
  return ticks;
}

function runEngineOver(ticks: OptionTradeTick[]): FlowEvent[] {
  const engine = new Engine(testConfig());
  const out: FlowEvent[] = [];
  for (const t of ticks) out.push(...engine.push(t));
  out.push(...engine.flush());
  return out;
}

describe("determinism", () => {
  it("synthetic feed: same seed ⇒ byte-identical tape", async () => {
    const [a, b] = await Promise.all([collectTicks(7, 1500), collectTicks(7, 1500)]);
    expect(a.length).toBe(1500);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  }, 30_000);

  it("different seeds ⇒ different tapes", async () => {
    const [a, b] = await Promise.all([collectTicks(7, 300), collectTicks(8, 300)]);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  }, 30_000);

  it("engine: same tape + same config ⇒ byte-identical events, ids included", async () => {
    const ticks = await collectTicks(11, 2500);
    const a = runEngineOver(ticks);
    const b = runEngineOver(ticks);
    expect(a.length).toBeGreaterThan(0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Sanity: the tape actually exercised the interesting paths.
    const kinds = new Set(a.map((e) => e.kind));
    expect(kinds.has("sweep")).toBe(true);
    expect(kinds.has("block")).toBe(true);
  }, 60_000);

  it("no print is double-counted across sweeps and singles", async () => {
    const ticks = await collectTicks(11, 2500);
    const events = runEngineOver(ticks);
    const seqs = events.filter((e) => e.kind !== "split").flatMap((e) => e.legs.map((l) => l.seq));
    expect(new Set(seqs).size).toBe(seqs.length);
  }, 60_000);

  it("every event ships a decomposed score", async () => {
    const ticks = await collectTicks(11, 1200);
    for (const event of runEngineOver(ticks)) {
      const names = Object.keys(event.score.components);
      expect(names.sort()).toEqual(
        [
          "aggression",
          "premiumVsBaseline",
          "repetition",
          "urgency",
          "volOi",
          "volumeVsBaseline",
        ].sort(),
      );
      for (const c of Object.values(event.score.components)) {
        expect(c.raw).toBeTypeOf("object");
      }
    }
  }, 60_000);
});
