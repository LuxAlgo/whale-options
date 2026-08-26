/*
  `compareFeeds` — feed cross-validation. Deterministic substrates only:
  replayed tapes and seeded synthetic feeds (live comparison is wall-clock
  inherently; given the same input streams the report is deterministic).
*/
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compareFeeds } from "../src/compare/compare.js";
import { ReplayFeed, TapeWriter } from "../src/feeds/replay.js";
import { SyntheticFeed } from "../src/feeds/synthetic.js";
import type { FeedAdapter, RawOptionTrade } from "../src/feeds/types.js";
import { formatOcc } from "../src/occ.js";
import type { FeedId, NormalizedCondition } from "../src/types.js";
import { collectSyntheticTicks, FIXTURE_START, T0 } from "./helpers.js";

const tmpDir = mkdtempSync(join(tmpdir(), "whale-compare-"));
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

const UNDERLYINGS = ["NVDA", "SPY", "TSLA", "AAPL", "AMD"];

async function writeTape(name: string, seed: number, maxEvents: number): Promise<string> {
  const path = join(tmpDir, name);
  const writer = new TapeWriter(path);
  for (const tick of await collectSyntheticTicks({ seed, maxEvents })) writer.write(tick);
  await writer.close();
  return path;
}

/** Minimal in-test adapter: yields the given raw prints, already normalized. */
function stubAdapter(id: string, trades: RawOptionTrade[]): FeedAdapter {
  return {
    id: id as FeedId,
    capabilities: () => ({ realtime: false, greeksProvided: false, nbbo: false, conditions: true }),
    async *subscribeOptionTrades() {
      yield* trades;
    },
    getNbbo: async () => null,
    getChainSnapshot: async () => null,
    normalizeCondition: (code) => code as NormalizedCondition,
  };
}

const NVDA200C = formatOcc("NVDA", "2026-09-18", "C", 200);

function print(overrides: Partial<RawOptionTrade> = {}): RawOptionTrade {
  return {
    ts: T0,
    contract: NVDA200C,
    price: 2.5,
    size: 10,
    exchange: "C",
    conditions: ["regular"],
    ...overrides,
  };
}

describe("compareFeeds", () => {
  it("identity: the same tape replayed twice matches 100% with zero skew", async () => {
    const tape = await writeTape("identity.ndjson", 5, 500);
    const report = await compareFeeds({
      a: { id: "replay-a", adapter: new ReplayFeed(tape) },
      b: { id: "replay-b", adapter: new ReplayFeed(tape) },
      underlyings: UNDERLYINGS,
      durationMs: 60_000, // generous — both streams end on their own well before this
    });

    expect(report.ticks.a).toBe(500);
    expect(report.ticks.b).toBe(500);
    expect(report.matched).toBe(500);
    expect(report.onlyA).toBe(0);
    expect(report.onlyB).toBe(0);
    expect(report.matchedPct).toEqual({ ofA: 100, ofB: 100 });
    expect(report.conditionDisagreements).toEqual([]);
    expect(report.tsSkewMs).toEqual({ median: 0, p95: 0, min: 0, max: 0 });
    expect(report.samples.onlyA).toEqual([]);
    expect(report.samples.onlyB).toEqual([]);
    expect(report.nbboCoverage.a).toBe(1);
    expect(report.nbboCoverage.b).toBe(1);
  }, 30_000);

  it("divergence: tapes from different seeds diverge and the report says so", async () => {
    const feedA = new SyntheticFeed({
      seed: 5,
      startTs: FIXTURE_START,
      maxEvents: 400,
      pace: "asap",
    });
    const feedB = new SyntheticFeed({
      seed: 99,
      startTs: FIXTURE_START,
      maxEvents: 400,
      pace: "asap",
    });
    const report = await compareFeeds({
      a: { id: "synthetic-a", adapter: feedA },
      b: { id: "synthetic-b", adapter: feedB },
      underlyings: ["NVDA"],
      durationMs: 60_000,
    });

    expect(report.onlyA).toBeGreaterThan(0);
    expect(report.onlyB).toBeGreaterThan(0);
    expect(report.matchedPct.ofA).toBeLessThan(100);
    expect(report.matchedPct.ofB).toBeLessThan(100);
    expect(report.samples.onlyA.length).toBeGreaterThan(0);
    expect(report.samples.onlyB.length).toBeGreaterThan(0);
    expect(report.notes.length).toBeGreaterThanOrEqual(3);
    expect(report.notes.some((n) => n.includes("not proof of a bad feed"))).toBe(true);
  }, 30_000);

  it("condition disagreement: identical prints except one condition set", async () => {
    const base = [0, 1000, 2000, 3000, 4000].map((dt, i) =>
      print({ ts: T0 + dt, price: 2.5 + i * 0.05 }),
    );
    const shifted = base.map((t, i) => (i === 2 ? { ...t, conditions: ["iso"] } : { ...t }));
    const report = await compareFeeds({
      a: { id: "stub-a", adapter: stubAdapter("stub-a", base) },
      b: { id: "stub-b", adapter: stubAdapter("stub-b", shifted) },
      underlyings: ["NVDA"],
      durationMs: 5_000,
    });

    expect(report.matched).toBe(5);
    expect(report.conditionDisagreements).toEqual([
      { contract: NVDA200C, ts: T0 + 2000, a: ["regular"], b: ["iso"] },
    ]);
  });

  it("tolerance: a 400ms shift matches at 1000ms tolerance but not at 200ms", async () => {
    const base = [0, 5000, 10_000].map((dt, i) => print({ ts: T0 + dt, size: 10 + i }));
    const shifted = base.map((t) => ({ ...t, ts: t.ts + 400 }));

    const loose = await compareFeeds({
      a: { id: "a", adapter: stubAdapter("a", base) },
      b: { id: "b", adapter: stubAdapter("b", shifted) },
      underlyings: ["NVDA"],
      durationMs: 5_000,
      matchToleranceMs: 1000,
    });
    expect(loose.matched).toBe(3);
    expect(loose.onlyA).toBe(0);
    expect(loose.onlyB).toBe(0);
    expect(loose.tsSkewMs).toEqual({ median: 400, p95: 400, min: 400, max: 400 });

    const tight = await compareFeeds({
      a: { id: "a", adapter: stubAdapter("a", base) },
      b: { id: "b", adapter: stubAdapter("b", shifted) },
      underlyings: ["NVDA"],
      durationMs: 5_000,
      matchToleranceMs: 200,
    });
    expect(tight.matched).toBe(0);
    expect(tight.onlyA).toBe(3);
    expect(tight.onlyB).toBe(3);
    expect(tight.tsSkewMs).toBeNull();
  });

  it("caps: samples stop at 20 while counts stay exact", async () => {
    const onlyOnA = Array.from({ length: 30 }, (_, i) =>
      print({ ts: T0 + i * 1000, size: 100 + i }),
    );
    const report = await compareFeeds({
      a: { id: "a", adapter: stubAdapter("a", onlyOnA) },
      b: { id: "b", adapter: stubAdapter("b", []) },
      underlyings: ["NVDA"],
      durationMs: 5_000,
    });

    expect(report.ticks).toEqual({ a: 30, b: 0 });
    expect(report.matched).toBe(0);
    expect(report.onlyA).toBe(30);
    expect(report.samples.onlyA).toHaveLength(20);
    expect(report.samples.onlyA[0]).toEqual({
      contract: NVDA200C,
      ts: T0,
      price: 2.5,
      size: 100,
      exchange: "C",
    });
  });

  it("determinism: the same input streams produce byte-identical reports", async () => {
    const tapeA = await writeTape("det-a.ndjson", 7, 300);
    const tapeB = await writeTape("det-b.ndjson", 8, 300);
    const run = () =>
      compareFeeds({
        a: { id: "a", adapter: new ReplayFeed(tapeA) },
        b: { id: "b", adapter: new ReplayFeed(tapeB) },
        underlyings: UNDERLYINGS,
        durationMs: 60_000,
      });
    const [r1, r2] = [await run(), await run()];
    // startedAt is wall clock by nature; everything else must be identical.
    r1.window.startedAt = 0;
    r2.window.startedAt = 0;
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  }, 30_000);
});
