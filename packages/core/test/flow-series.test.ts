/*
  Per-print flow series: the aggregator is a pure function of the ticks it is
  fed, so the same tape (live or replayed from NDJSON) yields byte-identical
  buckets; the honesty rules (sign only from a trustworthy aggressor side,
  delta never guessed, cancels counted not retracted, the premium floor NOT
  applied) are pinned as behavior; and both flight recorders round-trip the
  rows unchanged.
*/
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TapeWriter } from "../src/feeds/replay.js";
import { SyntheticFeed } from "../src/feeds/synthetic.js";
import {
  blackScholesDeltaFromTick,
  FLOW_SERIES_NOTE,
  type FlowBucketRow,
  FlowSeriesAggregator,
  type FlowSeriesOptions,
  flowSeriesPayload,
  resampleFlowBuckets,
  spotBarsFromBuckets,
} from "../src/flow/series.js";
import { runEngine } from "../src/runner.js";
import { MemoryFlightRecorder } from "../src/store/memory.js";
import { SqliteFlightRecorder } from "../src/store/sqlite.js";
import type { OptionTradeTick } from "../src/types.js";
import { easternTimeToUtc } from "../src/util/session.js";
import {
  collectSyntheticTicks,
  makeTick,
  readTapeTicks,
  resetSeq,
  T0,
  testConfig,
} from "./helpers.js";

const OPTS: FlowSeriesOptions = { bucketMs: 60_000, nbboStaleMs: 5_000, r: 0.05, q: 0 };

function aggregate(ticks: OptionTradeTick[], opts: FlowSeriesOptions = OPTS): FlowSeriesAggregator {
  const agg = new FlowSeriesAggregator(opts);
  for (const t of ticks) agg.push(t);
  return agg;
}

function allRows(agg: FlowSeriesAggregator): FlowBucketRow[] {
  const out: FlowBucketRow[] = [];
  for (const u of agg.underlyings()) {
    for (const d of agg.sessionDates(u)) out.push(...agg.series(u, d));
  }
  return out;
}

const scratch = mkdtempSync(join(tmpdir(), "whale-flow-series-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("flow series: sign, side, and exclusions", () => {
  it("buys at the ask add positive premium; sells at the bid add to the sell bucket", () => {
    resetSeq();
    const agg = aggregate([
      makeTick({ price: 2.5, size: 10 }), // at ask ⇒ buy: $2,500
      makeTick({ price: 2.45, size: 4 }), // at bid ⇒ sell: $980
      makeTick({
        contract: { underlying: "NVDA", expiry: "2026-09-18", right: "P", strike: 190 },
        price: 2.5,
        size: 2,
      }), // put buy: $500
    ]);
    const [row] = agg.series("NVDA", "2026-08-24");
    expect(row).toBeDefined();
    expect(row?.prints).toBe(3);
    expect(row?.sided).toBe(3);
    expect(row?.callPremiumBuy).toBe(2500);
    expect(row?.callPremiumSell).toBe(980);
    expect(row?.putPremiumBuy).toBe(500);
    expect(row?.buyVolume).toBe(12);
    expect(row?.sellVolume).toBe(4);
    const payload = flowSeriesPayload(
      "NVDA",
      "2026-08-24",
      agg.series("NVDA", "2026-08-24"),
      60_000,
    );
    expect(payload.buckets[0]?.callNet).toBe(1520);
    expect(payload.buckets[0]?.putNet).toBe(500);
    expect(payload.buckets[0]?.netPremium).toBe(1020); // callNet − putNet
    expect(payload.buckets[0]?.netVolume).toBe(8);
  });

  it("mid prints, unknown sides, and side-voiding conditions are counted, never signed", () => {
    resetSeq();
    const agg = aggregate([
      makeTick({ price: 2.47, size: 10 }), // between the quotes ⇒ mid
      makeTick({ price: 2.5, size: 10, nbbo: null }), // no NBBO ⇒ unknown
      makeTick({ price: 2.5, size: 10, conditions: ["spread-leg"] }), // side voided by policy
      makeTick({
        price: 2.5,
        size: 10,
        nbbo: { bid: 2.45, ask: 2.5, bidSize: 1, askSize: 1, ts: T0 - 60_000 },
      }), // stale
    ]);
    const [row] = agg.series("NVDA", "2026-08-24");
    expect(row?.prints).toBe(4);
    expect(row?.sided).toBe(0);
    expect(row?.unsided).toBe(4);
    expect(row?.callPremiumBuy).toBe(0);
    expect(row?.callPremiumSell).toBe(0);
    expect(row?.directionalDelta).toBe(0);
    expect((row?.buyVolume ?? 0) + (row?.sellVolume ?? 0)).toBe(0);
  });

  it("cancels are counted and nothing is retracted", () => {
    resetSeq();
    const agg = aggregate([
      makeTick({ price: 2.5, size: 10 }),
      makeTick({ price: 2.5, size: 10, conditions: ["cancel"] }),
    ]);
    const [row] = agg.series("NVDA", "2026-08-24");
    expect(row?.prints).toBe(1);
    expect(row?.cancels).toBe(1);
    expect(row?.callPremiumBuy).toBe(2500);
  });

  it("the premium floor does not apply: a $25 print counts", () => {
    resetSeq();
    const agg = aggregate([
      makeTick({
        price: 0.25,
        size: 1,
        nbbo: { bid: 0.2, ask: 0.25, bidSize: 5, askSize: 5, ts: T0 - 50 },
      }),
    ]);
    const [row] = agg.series("NVDA", "2026-08-24");
    expect(row?.callPremiumBuy).toBe(25);
    expect(FLOW_SERIES_NOTE).toContain("premium floor");
    expect(FLOW_SERIES_NOTE).toContain("do NOT apply");
  });

  it("builds the spot tape from tick.spot observations and reports gaps as missing", () => {
    resetSeq();
    const agg = aggregate([
      makeTick({ spot: 195 }),
      makeTick({ spot: 197 }),
      makeTick({ spot: 194.5 }),
      makeTick({ spot: null }),
      makeTick({ spot: 196, ts: T0 + 60_000 }),
    ]);
    const rows = agg.series("NVDA", "2026-08-24");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      spotOpen: 195,
      spotHigh: 197,
      spotLow: 194.5,
      spotClose: 194.5,
      spotObservations: 3,
      prints: 4,
    });
    expect(rows[1]?.spotObservations).toBe(1);
    const bars = spotBarsFromBuckets(rows, 300_000);
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({
      open: 195,
      high: 197,
      low: 194.5,
      close: 196,
      observations: 4,
    });
    expect(FLOW_SERIES_NOTE).toContain("SPOT TAPE FROM PRINTS");
  });

  it("resets per session date", () => {
    resetSeq();
    const agg = aggregate([
      makeTick({ ts: easternTimeToUtc("2026-08-24", 15, 59) }),
      makeTick({ ts: easternTimeToUtc("2026-08-25", 9, 31) }),
    ]);
    expect(agg.sessionDates("NVDA")).toEqual(["2026-08-24", "2026-08-25"]);
    expect(agg.series("NVDA", "2026-08-24")).toHaveLength(1);
    expect(agg.series("NVDA", "2026-08-25")).toHaveLength(1);
    const p = flowSeriesPayload("NVDA", "2026-08-25", agg.series("NVDA", "2026-08-25"), 60_000);
    expect(p.buckets[0]?.cumNetPremium).toBe(2500); // does not carry the prior day
  });
});

describe("flow series: delta source", () => {
  it("prefers the chain snapshot's delta, falls back to Black-Scholes, and never guesses", () => {
    resetSeq();
    const withLookup = aggregate([makeTick({ price: 2.5, size: 10 })], {
      ...OPTS,
      deltaLookup: () => 0.4,
    });
    const [chainRow] = withLookup.series("NVDA", "2026-08-24");
    expect(chainRow?.deltaFromChain).toBe(1);
    expect(chainRow?.directionalDelta).toBe(400); // 0.4 × 10 × 100 × +1

    resetSeq();
    const tick = makeTick({ price: 2.5, size: 10 });
    const bs = blackScholesDeltaFromTick(tick, 0.05, 0);
    expect(bs).not.toBeNull();
    expect(bs ?? 0).toBeGreaterThan(0);
    expect(bs ?? 1).toBeLessThan(1);
    const fallback = aggregate([tick]);
    const [bsRow] = fallback.series("NVDA", "2026-08-24");
    expect(bsRow?.deltaFromBlackScholes).toBe(1);
    expect(bsRow?.directionalDelta).toBeCloseTo((bs ?? 0) * 10 * 100, 3);

    resetSeq();
    const noSpot = aggregate([makeTick({ price: 2.5, size: 10, spot: null })]);
    const [missingRow] = noSpot.series("NVDA", "2026-08-24");
    expect(missingRow?.sided).toBe(1);
    expect(missingRow?.deltaMissing).toBe(1);
    expect(missingRow?.directionalDelta).toBe(0);

    const payload = flowSeriesPayload(
      "NVDA",
      "2026-08-24",
      noSpot.series("NVDA", "2026-08-24"),
      60_000,
    );
    expect(payload.deltaSource).toContain("no derivable delta");
    expect(payload.note).toContain("never guessed");
  });

  it("puts carry negative delta so buying puts moves directional delta down", () => {
    resetSeq();
    const agg = aggregate([
      makeTick({
        contract: { underlying: "NVDA", expiry: "2026-09-18", right: "P", strike: 185 },
        price: 2.5,
        size: 10,
      }),
    ]);
    const [row] = agg.series("NVDA", "2026-08-24");
    expect(row?.deltaFromBlackScholes).toBe(1);
    expect(row?.directionalDelta).toBeLessThan(0);
  });
});

describe("flow series: determinism and replay parity", () => {
  it("same tape ⇒ byte-identical buckets", async () => {
    const ticks = await collectSyntheticTicks({ seed: 21, maxEvents: 1500 });
    const a = allRows(aggregate(ticks));
    const b = allRows(aggregate(ticks));
    expect(a.length).toBeGreaterThan(10);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // The tape exercised every path the note promises to count.
    const totals = flowSeriesPayload(
      "NVDA",
      "2026-08-24",
      aggregate(ticks).series("NVDA", "2026-08-24"),
      60_000,
    ).totals;
    expect(totals.sided).toBeGreaterThan(0);
    expect(totals.unsided).toBeGreaterThan(0);
    expect(totals.deltaFromBlackScholes).toBeGreaterThan(0);
  }, 60_000);

  it("a recorded NDJSON tape replays to the same buckets", async () => {
    const ticks = await collectSyntheticTicks({ seed: 21, maxEvents: 1500 });
    const path = join(scratch, "parity.ndjson");
    const writer = new TapeWriter(path);
    for (const t of ticks) writer.write(t);
    await writer.close();
    const replayed = await readTapeTicks(path);
    expect(replayed).toHaveLength(ticks.length);
    expect(JSON.stringify(allRows(aggregate(replayed)))).toBe(
      JSON.stringify(allRows(aggregate(ticks))),
    );
  }, 60_000);

  it("the runner persists exactly what a standalone pass over the tape produces", async () => {
    const config = testConfig();
    const feed = new SyntheticFeed({
      seed: 21,
      startTs: easternTimeToUtc("2026-08-24", 9, 30),
      maxEvents: 1200,
      pace: "asap",
      regime: "mixed",
    });
    const store = new MemoryFlightRecorder();
    const tapePath = join(scratch, "runner.ndjson");
    const published: FlowBucketRow[] = [];
    config.universe.underlyings = ["NVDA", "SPY"];
    await runEngine({
      config,
      adapter: feed,
      store,
      record: new TapeWriter(tapePath),
      onFlowBuckets: (rows) => published.push(...rows),
    });
    const tape = await readTapeTicks(tapePath, "synthetic");
    const standalone = aggregate(tape, {
      bucketMs: config.flowSeries.bucketMs,
      nbboStaleMs: config.engine.nbboStaleMs,
      r: config.greeks.r,
      q: config.greeks.q,
    });
    for (const u of standalone.underlyings()) {
      for (const d of standalone.sessionDates(u)) {
        expect(store.getFlowBuckets(u, d)).toEqual(standalone.series(u, d));
      }
    }
    expect(store.flowUnderlyings()).toEqual(standalone.underlyings());
    // Live listeners saw every bucket the store holds (last write per bucket wins).
    const last = new Map(published.map((r) => [`${r.underlying}|${r.sessionDate}|${r.ts}`, r]));
    for (const u of standalone.underlyings()) {
      for (const row of standalone.series(u, "2026-08-24")) {
        expect(last.get(`${u}|${row.sessionDate}|${row.ts}`)).toEqual(row);
      }
    }
  }, 60_000);
});

describe("flow series: resampling and persistence", () => {
  it("re-buckets onto a coarser grid and refuses non-multiples", async () => {
    const ticks = await collectSyntheticTicks({ seed: 5, maxEvents: 800 });
    const rows = aggregate(ticks).series("NVDA", "2026-08-24");
    const five = resampleFlowBuckets(rows, 300_000);
    expect(five.length).toBeLessThan(rows.length);
    const sum = (xs: FlowBucketRow[]) => xs.reduce((a, r) => a + r.callPremiumBuy + r.prints, 0);
    expect(sum(five)).toBeCloseTo(sum(rows), 6);
    expect(five.every((r) => r.bucketMs === 300_000 && r.ts % 300_000 === 0)).toBe(true);
    expect(() => resampleFlowBuckets(rows, 90_000)).toThrow(/multiple/);
  }, 30_000);

  it("both flight recorders round-trip buckets and list sessions/underlyings", async () => {
    const ticks = await collectSyntheticTicks({ seed: 5, maxEvents: 800 });
    const agg = aggregate(ticks);
    const rows = allRows(agg);
    for (const store of [new MemoryFlightRecorder(), new SqliteFlightRecorder(":memory:")]) {
      store.upsertFlowBuckets(rows);
      store.upsertFlowBuckets(rows.slice(0, 3)); // idempotent upsert
      for (const u of agg.underlyings()) {
        expect(store.getFlowBuckets(u, "2026-08-24")).toEqual(agg.series(u, "2026-08-24"));
      }
      expect(store.flowSessionDates()).toEqual(["2026-08-24"]);
      expect(store.flowSessionDates("NVDA")).toEqual(["2026-08-24"]);
      expect(store.flowUnderlyings()).toEqual(agg.underlyings());
      expect(store.getFlowBuckets("ZZZZ", "2026-08-24")).toEqual([]);
      store.close();
    }
  }, 30_000);
});
