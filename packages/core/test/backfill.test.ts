/*
  Backfill: warming baselines from historical sessions kills the cold start.
  Covered here: trading-day math, baseline/day-history writes on both stores,
  the payoff (an engine hydrated from backfilled baselines scores warm where
  an empty-baseline engine flags coldStart), idempotency, the graceful skip
  path, and the vendor historical mappers (invented vendor-shaped payloads
  only — never recordings).
*/
import { describe, expect, it } from "vitest";
import { backfill, tradingDaysBack } from "../src/backfill/index.js";
import { Engine } from "../src/engine.js";
import { mapAlpacaHistoricalTrade } from "../src/feeds/alpaca.js";
import { mapMassiveHistoricalTrade } from "../src/feeds/massive.js";
import { SyntheticFeed } from "../src/feeds/synthetic.js";
import { mapThetaHistoryTrade } from "../src/feeds/thetadata.js";
import type { FeedAdapter } from "../src/feeds/types.js";
import { MemoryFlightRecorder } from "../src/store/memory.js";
import { SqliteFlightRecorder } from "../src/store/sqlite.js";
import type { FlightRecorder } from "../src/store/types.js";
import type { FlowEvent } from "../src/types.js";
import { easternTimeToUtc } from "../src/util/session.js";
import { collectSyntheticTicks, FIXTURE_START, testConfig } from "./helpers.js";

// FIXTURE_START is 2026-08-24 (a Monday); the six weekdays before it.
const LIVE_DATE = "2026-08-24";
const DATES = tradingDaysBack(LIVE_DATE, 6);
const UNDERLYINGS = ["NVDA", "SPY"];

function syntheticAdapter(): SyntheticFeed {
  return new SyntheticFeed({ seed: 42, startTs: FIXTURE_START, pace: "asap" });
}

function runBackfill(store: FlightRecorder, adapter: FeedAdapter = syntheticAdapter()) {
  return backfill({
    store,
    adapter,
    config: testConfig(),
    underlyings: UNDERLYINGS,
    dates: DATES,
  });
}

function eachStore(name: string, fn: (store: FlightRecorder) => void | Promise<void>) {
  it(`${name} (sqlite)`, async () => {
    const store = new SqliteFlightRecorder(":memory:");
    await fn(store);
    store.close();
  }, 120_000);
  it(`${name} (memory)`, async () => {
    const store = new MemoryFlightRecorder();
    await fn(store);
    store.close();
  }, 120_000);
}

describe("tradingDaysBack", () => {
  it("returns the last N weekdays strictly before the date, oldest first", () => {
    expect(tradingDaysBack("2026-08-24", 6)).toEqual([
      "2026-08-14",
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
      "2026-08-20",
      "2026-08-21",
    ]);
  });

  it("skips weekends and excludes the from-date itself", () => {
    // 2026-08-24 is a Monday: one session back is the prior Friday.
    expect(tradingDaysBack("2026-08-24", 1)).toEqual(["2026-08-21"]);
    // From a Sunday, the nearest prior weekday is that same Friday.
    expect(tradingDaysBack("2026-08-23", 1)).toEqual(["2026-08-21"]);
    expect(tradingDaysBack("2026-08-24", 0)).toEqual([]);
    expect(() => tradingDaysBack("not-a-date", 3)).toThrow(/invalid date/);
  });
});

describe("backfill", () => {
  eachStore("six sessions yield full baseline coverage and daily history", async (store) => {
    const summary = await runBackfill(store);
    expect(summary.sessions).toBe(6);
    expect(summary.skippedDates).toEqual([]);
    expect(summary.ticksProcessed).toBeGreaterThan(1000);
    expect(summary.contractsTouched).toBeGreaterThan(50);
    // One historical chain per (date × underlying).
    expect(summary.chainsFolded).toBe(DATES.length * UNDERLYINGS.length);

    expect(store.baselineSessionDates()).toEqual(DATES);
    for (const u of UNDERLYINGS) expect(store.contractDailySessionDates(u)).toEqual(DATES);
    // Chain folds also produce per-underlying closes for every session.
    expect(store.getUnderlyingDaily("NVDA").map((r) => r.sessionDate)).toEqual(DATES);
    // Ticks are never persisted by backfill — baselines only.
    expect(store.countTicks({})).toBe(0);

    // Baselines hydrate: liquid contracts carry multi-day volume history.
    const state = store.loadBaselineState(testConfig().score.lookbackDays);
    const contracts = store.getContractDailyByUnderlying("NVDA", DATES[DATES.length - 1] ?? "");
    const covered = contracts.filter((c) => state.coverageDays(c.contract) >= 5);
    expect(covered.length).toBeGreaterThan(0);
  });

  eachStore(
    "payoff: backfilled baselines score warm where empty baselines are cold",
    async (store) => {
      await runBackfill(store);
      const config = testConfig();
      const liveTicks = await collectSyntheticTicks({ seed: 7, maxEvents: 2000 });

      const run = (engine: Engine): FlowEvent[] => {
        const out: FlowEvent[] = [];
        for (const tick of liveTicks) out.push(...engine.push(tick));
        out.push(...engine.flush());
        return out;
      };
      const warmEvents = run(
        new Engine(config, store.loadBaselineState(config.score.lookbackDays)),
      );
      const coldEvents = run(new Engine(config));

      // Empty baselines: every event is coldStart with zero coverage.
      expect(coldEvents.length).toBeGreaterThan(0);
      expect(coldEvents.every((e) => e.score.coldStart && e.score.baselineDays === 0)).toBe(true);

      // Warm baselines: recurring contracts on the backfilled names reach
      // coverage ≥ minBaselineDays, drop the coldStart flag, and score the
      // volumeVsBaseline component from a real average.
      const backfilled = warmEvents.filter((e) => UNDERLYINGS.includes(e.underlying));
      expect(backfilled.length).toBeGreaterThan(0);
      for (const e of backfilled) {
        expect(e.score.coldStart).toBe(e.score.baselineDays < config.score.minBaselineDays);
      }
      const warm = backfilled.filter((e) => e.score.baselineDays >= config.score.minBaselineDays);
      expect(warm.length).toBeGreaterThan(0);
      for (const e of warm) {
        expect(e.score.coldStart).toBe(false);
        expect(e.score.components.volumeVsBaseline.value).not.toBeNull();
      }
    },
  );

  eachStore("re-running the same window is idempotent", async (store) => {
    const first = await runBackfill(store);
    const datesAfterFirst = store.baselineSessionDates();
    const contract = store
      .getContractDailyByUnderlying("NVDA", DATES[DATES.length - 1] ?? "")
      .map((r) => r.contract)
      .sort()[0];
    expect(contract).toBeDefined();
    const rowsAfterFirst = store.getContractDaily(contract ?? "");
    const stateAfterFirst = store.loadBaselineState(20);

    const second = await runBackfill(store);
    expect(second.sessions).toBe(first.sessions);
    expect(second.ticksProcessed).toBe(first.ticksProcessed);
    expect(store.baselineSessionDates()).toEqual(datesAfterFirst);
    expect(store.getContractDaily(contract ?? "")).toEqual(rowsAfterFirst);
    // Hydrated baseline state is unchanged too (volume averages included).
    const stateAfterSecond = store.loadBaselineState(20);
    expect(stateAfterSecond.avgDailyVolume(contract ?? "")).toEqual(
      stateAfterFirst.avgDailyVolume(contract ?? ""),
    );
  });

  eachStore("a throwing date is skipped; the rest of the window survives", async (store) => {
    const inner = syntheticAdapter();
    const badDate = DATES[2] ?? "";
    const adapter: FeedAdapter = {
      id: inner.id,
      capabilities: () => inner.capabilities(),
      subscribeOptionTrades: (filter, signal) => inner.subscribeOptionTrades(filter, signal),
      getNbbo: (contract) => inner.getNbbo(contract),
      getChainSnapshot: (underlying) => inner.getChainSnapshot(underlying),
      normalizeCondition: (code) => inner.normalizeCondition(code),
      getHistoricalOptionTrades: (underlying, dateIso, signal) => {
        if (dateIso === badDate) throw new Error("vendor 503 (invented)");
        return inner.getHistoricalOptionTrades(underlying, dateIso, signal);
      },
      getHistoricalChain: (underlying, dateIso) => inner.getHistoricalChain(underlying, dateIso),
    };
    const summary = await runBackfill(store, adapter);
    expect(summary.sessions).toBe(DATES.length - 1);
    expect(summary.skippedDates).toEqual([badDate]);
    expect(store.baselineSessionDates()).toEqual(DATES.filter((d) => d !== badDate));
    // The skipped date's chain is skipped with it — no half-ingested day.
    expect(summary.chainsFolded).toBe((DATES.length - 1) * UNDERLYINGS.length);
  });

  it("refuses an adapter without a historical trade surface", async () => {
    const inner = syntheticAdapter();
    const adapter: FeedAdapter = {
      id: inner.id,
      capabilities: () => inner.capabilities(),
      subscribeOptionTrades: (filter, signal) => inner.subscribeOptionTrades(filter, signal),
      getNbbo: (contract) => inner.getNbbo(contract),
      getChainSnapshot: (underlying) => inner.getChainSnapshot(underlying),
      normalizeCondition: (code) => inner.normalizeCondition(code),
    };
    const store = new MemoryFlightRecorder();
    await expect(runBackfill(store, adapter)).rejects.toThrow(/no historical trade surface/);
    store.close();
  });

  it("honors the abort signal between dates (no partial day folded)", async () => {
    const store = new MemoryFlightRecorder();
    const controller = new AbortController();
    let datesStarted = 0;
    const inner = syntheticAdapter();
    const adapter: FeedAdapter = {
      id: inner.id,
      capabilities: () => inner.capabilities(),
      subscribeOptionTrades: (filter, signal) => inner.subscribeOptionTrades(filter, signal),
      getNbbo: (contract) => inner.getNbbo(contract),
      getChainSnapshot: (underlying) => inner.getChainSnapshot(underlying),
      normalizeCondition: (code) => inner.normalizeCondition(code),
      getHistoricalOptionTrades: (underlying, dateIso, signal) => {
        if (underlying === UNDERLYINGS[0]) {
          datesStarted++;
          if (datesStarted === 3) controller.abort();
        }
        return inner.getHistoricalOptionTrades(underlying, dateIso, signal);
      },
      getHistoricalChain: (underlying, dateIso) => inner.getHistoricalChain(underlying, dateIso),
    };
    const summary = await backfill({
      store,
      adapter,
      config: testConfig(),
      underlyings: UNDERLYINGS,
      dates: DATES,
      signal: controller.signal,
    });
    // Two dates folded before the abort; the third never lands half-done.
    expect(summary.sessions).toBe(2);
    expect(store.baselineSessionDates()).toEqual(DATES.slice(0, 2));
  }, 120_000);
});

describe("vendor historical mappers (invented vendor-shaped payloads)", () => {
  it("thetadata: history trade rows map like their stream counterparts", () => {
    const trade = mapThetaHistoryTrade({
      symbol: "NVDA",
      expiration: "2026-09-18",
      strike: 190,
      right: "C",
      timestamp: "2026-08-20T09:30:00.471",
      price: 4.2,
      size: 25,
      exchange: 65,
      condition: 18,
      sequence: 1234,
    });
    expect(trade).not.toBeNull();
    expect(trade?.contract).toBe("NVDA260918C00190000");
    expect(trade?.ts).toBe(easternTimeToUtc("2026-08-20", 9, 30) + 471);
    expect(trade?.exchange).toBe("E"); // 65 = Cboe EDGX
    expect(trade?.conditions).toEqual(["18"]);
    expect(trade?.nbbo).toBeNull();
    // Torn rows are dropped, never guessed at.
    expect(mapThetaHistoryTrade({ symbol: "NVDA", price: 4.2 })).toBeNull();
    expect(
      mapThetaHistoryTrade({
        symbol: "NVDA",
        expiration: "2026-09-18",
        strike: 190,
        right: "C",
        price: 4.2,
        size: 25,
      }),
    ).toBeNull();
  });

  it("massive: REST trade rows carry ns timestamps and numeric ids", () => {
    const sipNs = 1_755_700_000_000 * 1e6; // epoch ns (ms × 1e6, exactly representable)
    const trade = mapMassiveHistoricalTrade("O:SPY260918C00650000", {
      sip_timestamp: sipNs,
      price: 3.15,
      size: 40,
      exchange: 316,
      conditions: [209],
      sequence_number: 99,
    });
    expect(trade).not.toBeNull();
    expect(trade?.contract).toBe("O:SPY260918C00650000");
    expect(trade?.ts).toBe(1_755_700_000_000);
    expect(trade?.exchange).toBe("Q"); // 316 = Nasdaq Options Market
    expect(trade?.conditions).toEqual(["209"]);
    expect(mapMassiveHistoricalTrade("O:SPY260918C00650000", { price: 3.15 })).toBeNull();
  });

  it("alpaca: historical trade rows reuse the stream's t/p/s/x/c keys", () => {
    const trade = mapAlpacaHistoricalTrade("AAPL260918P00230000", {
      t: "2026-08-20T13:30:00.123Z",
      p: 2.45,
      s: 12,
      x: "C",
      c: "I",
    });
    expect(trade).not.toBeNull();
    expect(trade?.contract).toBe("AAPL260918P00230000");
    expect(trade?.ts).toBe(Date.parse("2026-08-20T13:30:00.123Z"));
    expect(trade?.conditions).toEqual(["I"]);
    expect(
      mapAlpacaHistoricalTrade("AAPL260918P00230000", { t: "2026-08-20T13:30:00Z", p: 2.45 }),
    ).toBeNull();
    expect(
      mapAlpacaHistoricalTrade("AAPL260918P00230000", { t: "garbage", p: 1, s: 1 }),
    ).toBeNull();
  });
});
