/*
  `whale audit` — calibration of recorded scores against forward underlying
  moves. Shape and accounting on a synthetic tape, determinism, exact
  forward-return math on a hand-built store, cross-session horizons from
  underlying_daily rows, and the exclusion bookkeeping for mid/unknown sides.
*/
import { describe, expect, it } from "vitest";
import { calibrate } from "../src/audit/calibration.js";
import { MemoryFlightRecorder } from "../src/store/memory.js";
import type { FlightRecorder } from "../src/store/types.js";
import type { FlowEvent, ScoreComponentName, WhaleScore } from "../src/types.js";
import { easternTimeToUtc, sessionDateOf } from "../src/util/session.js";
import { collectSyntheticTicks, makeTick, runEngineOver, T0 } from "./helpers.js";

const MIN = 60_000;

function stubScore(total: number, coldStart = false): WhaleScore {
  const names: ScoreComponentName[] = [
    "volumeVsBaseline",
    "premiumVsBaseline",
    "volOi",
    "aggression",
    "urgency",
    "repetition",
  ];
  const components = Object.fromEntries(
    names.map((n) => [n, { value: null, weight: 1 / 6, weighted: null, raw: {} }]),
  ) as WhaleScore["components"];
  return { total, components, missing: names, baselineDays: 0, coldStart };
}

function makeEvent(overrides: Partial<FlowEvent> & { id: string }): FlowEvent {
  const leg = makeTick({ ts: overrides.ts ?? T0, spot: overrides.spot ?? 100 });
  return {
    ts: T0,
    sessionDate: sessionDateOf(overrides.ts ?? T0),
    kind: "block",
    side: "buy",
    underlying: "NVDA",
    contract: leg.contract,
    expiry: leg.expiry,
    strike: leg.strike,
    right: leg.right,
    legs: [leg],
    legCount: 1,
    premium: leg.price * leg.size * 100,
    size: leg.size,
    price: leg.price,
    dte: 25,
    otmPct: 0.02,
    spot: 100,
    volOiRatio: null,
    oi: leg.oi,
    exchanges: [leg.exchange],
    score: stubScore(75),
    reasons: ["test event"],
    feedId: "synthetic",
    seq: leg.seq,
    ...overrides,
  };
}

/** Spot-bearing tick at a given time — a forward-price observation. */
function spotObs(ts: number, spot: number, underlying = "NVDA") {
  return makeTick({
    ts,
    spot,
    contract: { underlying, expiry: "2026-09-18", right: "C", strike: 200 },
  });
}

/** ~145 synthetic ticks/minute — 4000 spans ~28 minutes, enough for a 15m horizon. */
async function syntheticStore(
  maxEvents = 4000,
): Promise<{ store: FlightRecorder; from: number; to: number }> {
  const store = new MemoryFlightRecorder();
  const ticks = await collectSyntheticTicks({ seed: 7, maxEvents });
  const events = runEngineOver(ticks);
  store.insertTicks(ticks);
  store.insertEvents(events);
  return { store, from: ticks[0]!.ts, to: ticks[ticks.length - 1]!.ts };
}

describe("calibrate — report shape on a synthetic tape", () => {
  it("buckets cover observed scores, counts reconcile, caveats always present", async () => {
    const { store, from, to } = await syntheticStore();
    const report = await calibrate({ store, from, to, horizon: "15m" });

    expect(report.window).toEqual({ from, to });
    expect(report.horizon).toBe("15m");
    expect(report.eventsConsidered).toBeGreaterThan(0);
    expect(report.eventsWithOutcome).toBeGreaterThan(0);

    // Exclusion accounting: considered = with-outcome + every exclusion bucket.
    const { mid, unknown, noPriceData } = report.excluded;
    expect(report.eventsWithOutcome + mid + unknown + noPriceData).toBe(report.eventsConsidered);

    // Bucket ns sum to eventsWithOutcome, in the main table and in both cuts.
    for (const table of [report.buckets, report.byKind, report.bySide]) {
      expect(table.reduce((s, b) => s + b.n, 0)).toBe(report.eventsWithOutcome);
      for (const b of table) {
        expect(b.n).toBeGreaterThan(0);
        expect(b.smallN).toBe(b.n < 30);
      }
    }
    expect(report.buckets.every((b) => /^\d+-\d+$/.test(b.label))).toBe(true);

    // Caveats are non-negotiable — and this tape is synthetic, so say so loudly.
    expect(report.caveats.length).toBeGreaterThanOrEqual(6);
    expect(report.caveats.some((c) => c.includes("SYNTHETIC TAPE"))).toBe(true);
    expect(report.caveats.some((c) => c.toLowerCase().includes("not trading advice"))).toBe(true);
  });

  it("same store ⇒ identical report JSON (determinism)", async () => {
    const [a, b] = [await syntheticStore(), await syntheticStore()];
    const ra = await calibrate({ store: a.store, from: a.from, to: a.to, horizon: "1h" });
    const rb = await calibrate({ store: b.store, from: b.from, to: b.to, horizon: "1h" });
    expect(JSON.stringify(ra)).toBe(JSON.stringify(rb));
    // And re-running on the very same store instance changes nothing either.
    const ra2 = await calibrate({ store: a.store, from: a.from, to: a.to, horizon: "1h" });
    expect(JSON.stringify(ra2)).toBe(JSON.stringify(ra));
  });
});

describe("calibrate — forward-price correctness on a hand-built store", () => {
  it("15m: exact return from the first spot observation at ts ≥ target", async () => {
    const store = new MemoryFlightRecorder();
    // Spot 100 at the event; 103 five seconds after the 15m target — the
    // observation the sweep must pick; a decoy before the target must not count.
    store.insertTicks([
      spotObs(T0, 100),
      spotObs(T0 + 14 * MIN, 250), // before target — must be ignored
      spotObs(T0 + 15 * MIN + 5_000, 103),
      spotObs(T0 + 16 * MIN, 999), // later — not the first ≥ target
    ]);
    store.insertEvents([
      makeEvent({ id: "buy-up", side: "buy", spot: 100, score: stubScore(75) }),
      makeEvent({ id: "sell-up", side: "sell", spot: 100, score: stubScore(15) }),
    ]);

    const report = await calibrate({ store, from: T0 - MIN, to: T0 + MIN, horizon: "15m" });
    expect(report.eventsWithOutcome).toBe(2);
    expect(report.excluded).toEqual({ mid: 0, unknown: 0, noPriceData: 0 });

    const buyBucket = report.buckets.find((b) => b.label === "70-80")!;
    expect(buyBucket.n).toBe(1);
    expect(buyBucket.medianFwdReturnPct).toBe(3); // (103 − 100) / 100
    expect(buyBucket.meanFwdReturnPct).toBe(3);
    expect(buyBucket.alignedPct).toBe(100); // buy, underlying up
    expect(buyBucket.smallN).toBe(true);

    const sellBucket = report.buckets.find((b) => b.label === "10-20")!;
    expect(sellBucket.medianFwdReturnPct).toBe(3);
    expect(sellBucket.alignedPct).toBe(0); // sell, underlying up

    expect(report.baseRate.alignedPct).toBe(50);
    expect(report.baseRate.medianFwdReturnPct).toBe(3);
    expect(report.bySide.map((b) => [b.label, b.alignedPct])).toEqual([
      ["buy", 100],
      ["sell", 0],
    ]);
  });

  it("15m: no observation within the 20-minute tolerance ⇒ noPriceData", async () => {
    const store = new MemoryFlightRecorder();
    // Next spot observation is 36m after the target — outside tolerance.
    store.insertTicks([spotObs(T0, 100), spotObs(T0 + 51 * MIN, 104)]);
    store.insertEvents([makeEvent({ id: "orphan", side: "buy", spot: 100 })]);
    const report = await calibrate({ store, from: T0 - MIN, to: T0 + MIN, horizon: "15m" });
    expect(report.eventsWithOutcome).toBe(0);
    expect(report.excluded.noPriceData).toBe(1);
    expect(report.buckets).toEqual([]);
    expect(report.baseRate).toEqual({ alignedPct: null, medianFwdReturnPct: null });
    expect(report.caveats.length).toBeGreaterThan(0);
  });

  it("eod/1d/5d: forward closes come from underlying_daily rows", async () => {
    const store = new MemoryFlightRecorder();
    store.insertEvents([makeEvent({ id: "cross", side: "buy", spot: 100 })]); // 2026-08-24
    const closes: Array<[string, number]> = [
      ["2026-08-24", 101],
      ["2026-08-25", 102],
      ["2026-08-26", 98],
      ["2026-08-27", 99],
      ["2026-08-28", 103],
      ["2026-08-31", 110],
    ];
    store.upsertUnderlyingDaily(
      closes.map(([sessionDate, spotClose]) => ({
        underlying: "NVDA",
        sessionDate,
        spotClose,
        atmIv: null,
      })),
    );

    const at = (horizon: "eod" | "1d" | "5d") =>
      calibrate({ store, from: T0 - MIN, to: T0 + MIN, horizon });

    expect((await at("eod")).buckets[0]!.medianFwdReturnPct).toBe(1); // 101 vs 100
    expect((await at("1d")).buckets[0]!.medianFwdReturnPct).toBe(2); // 2026-08-25 close
    expect((await at("5d")).buckets[0]!.medianFwdReturnPct).toBe(10); // 2026-08-31 close
  });

  it("1d: missing daily history ⇒ noPriceData, never a guess", async () => {
    const store = new MemoryFlightRecorder();
    store.insertEvents([makeEvent({ id: "no-history", side: "buy", spot: 100 })]);
    const report = await calibrate({ store, from: T0 - MIN, to: T0 + MIN, horizon: "1d" });
    expect(report.eventsWithOutcome).toBe(0);
    expect(report.excluded.noPriceData).toBe(1);
  });

  it("eod without a daily row falls back to the session's last spot observation", async () => {
    const store = new MemoryFlightRecorder();
    store.insertTicks([spotObs(T0, 100), spotObs(easternTimeToUtc("2026-08-24", 15, 59), 97)]);
    store.insertEvents([makeEvent({ id: "eod-fallback", side: "sell", spot: 100 })]);
    const report = await calibrate({ store, from: T0 - MIN, to: T0 + MIN, horizon: "eod" });
    expect(report.eventsWithOutcome).toBe(1);
    expect(report.buckets[0]!.medianFwdReturnPct).toBe(-3);
    expect(report.buckets[0]!.alignedPct).toBe(100); // sell, underlying down
  });

  it("mid and unknown sides are excluded and counted, never bucketed", async () => {
    const store = new MemoryFlightRecorder();
    store.insertTicks([spotObs(T0, 100), spotObs(T0 + 15 * MIN, 101)]);
    store.insertEvents([
      makeEvent({ id: "m1", side: "mid" }),
      makeEvent({ id: "m2", side: "mid" }),
      makeEvent({ id: "u1", side: "unknown" }),
      makeEvent({ id: "b1", side: "buy", spot: 100 }),
      makeEvent({ id: "b2", side: "buy", spot: null }), // no spot at event time
    ]);
    const report = await calibrate({ store, from: T0 - MIN, to: T0 + MIN, horizon: "15m" });
    expect(report.eventsConsidered).toBe(5);
    expect(report.excluded).toEqual({ mid: 2, unknown: 1, noPriceData: 1 });
    expect(report.eventsWithOutcome).toBe(1);
    expect(report.bySide).toHaveLength(1);
    expect(report.bySide[0]!.label).toBe("buy");
  });

  it("excludeColdStart drops cold-start events from consideration", async () => {
    const store = new MemoryFlightRecorder();
    store.insertTicks([spotObs(T0, 100), spotObs(T0 + 15 * MIN, 101)]);
    store.insertEvents([
      makeEvent({ id: "warm", side: "buy", score: stubScore(50, false) }),
      makeEvent({ id: "cold", side: "buy", score: stubScore(50, true) }),
    ]);
    const all = await calibrate({ store, from: T0 - MIN, to: T0 + MIN, horizon: "15m" });
    const warmOnly = await calibrate({
      store,
      from: T0 - MIN,
      to: T0 + MIN,
      horizon: "15m",
      excludeColdStart: true,
    });
    expect(all.eventsConsidered).toBe(2);
    expect(warmOnly.eventsConsidered).toBe(1);
  });
});
