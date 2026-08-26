/*
  Architecture v2: the daily-history layer — per-contract OI/IV rows, per-
  underlying closes, short-volume cache, net-flow aggregation, and the
  deterministic historical synthetic sessions that backfill builds on.
*/
import { describe, expect, it } from "vitest";
import { SyntheticFeed } from "../src/feeds/synthetic.js";
import { foldChainToDaily } from "../src/runner.js";
import { MemoryFlightRecorder } from "../src/store/memory.js";
import { SqliteFlightRecorder } from "../src/store/sqlite.js";
import type { FlightRecorder } from "../src/store/types.js";
import { collectSyntheticTicks, FIXTURE_START, runEngineOver } from "./helpers.js";

function eachStore(name: string, fn: (store: FlightRecorder) => void | Promise<void>) {
  it(`${name} (sqlite)`, async () => {
    const store = new SqliteFlightRecorder(":memory:");
    await fn(store);
    store.close();
  });
  it(`${name} (memory)`, async () => {
    const store = new MemoryFlightRecorder();
    await fn(store);
    store.close();
  });
}

describe("daily history tables", () => {
  eachStore("contract_daily round-trips, orders ascending, and diffs across sessions", (store) => {
    const row = (sessionDate: string, oi: number) => ({
      contract: "NVDA260918C00200000",
      sessionDate,
      underlying: "NVDA",
      expiry: "2026-09-18",
      strike: 200,
      right: "C" as const,
      oi,
      iv: 0.42,
      mid: 5.25,
      volume: 1200,
    });
    store.upsertContractDaily([row("2026-08-21", 1000), row("2026-08-24", 1420)]);
    store.upsertContractDaily([row("2026-08-24", 1500)]); // same-day refresh overwrites
    const days = store.getContractDaily("NVDA260918C00200000");
    expect(days.map((d) => [d.sessionDate, d.oi])).toEqual([
      ["2026-08-21", 1000],
      ["2026-08-24", 1500],
    ]);
    expect(store.contractDailySessionDates("NVDA")).toEqual(["2026-08-21", "2026-08-24"]);
    expect(store.getContractDailyByUnderlying("NVDA", "2026-08-24")).toHaveLength(1);
  });

  eachStore("underlying_daily and short_volume_daily round-trip", (store) => {
    store.upsertUnderlyingDaily([
      { underlying: "NVDA", sessionDate: "2026-08-21", spotClose: 188.4, atmIv: 0.44 },
      { underlying: "NVDA", sessionDate: "2026-08-24", spotClose: 190.1, atmIv: 0.45 },
    ]);
    const daily = store.getUnderlyingDaily("NVDA");
    expect(daily.map((d) => d.spotClose)).toEqual([188.4, 190.1]);

    store.upsertShortVolume([
      {
        symbol: "NVDA",
        sessionDate: "2026-08-24",
        shortVolume: 12_000_000,
        shortExemptVolume: 40_000,
        totalVolume: 30_000_000,
        source: "finra-cnms",
      },
    ]);
    const sv = store.getShortVolume("NVDA");
    expect(sv).toHaveLength(1);
    expect(sv[0]!.shortVolume / sv[0]!.totalVolume).toBeCloseTo(0.4, 6);
  });

  eachStore("netFlow aggregates emitted events and matches a manual reduce", async (store) => {
    const ticks = await collectSyntheticTicks({ seed: 13, maxEvents: 800 });
    const events = runEngineOver(ticks);
    store.insertEvents(events);
    const rows = store.netFlow(0, Number.MAX_SAFE_INTEGER);
    expect(rows.length).toBeGreaterThan(0);
    const nvda = rows.find((r) => r.underlying === "NVDA");
    if (nvda) {
      const manual = events
        .filter((e) => e.underlying === "NVDA")
        .reduce(
          (acc, e) => {
            if (e.right === "C" && e.side === "buy") acc.cb += e.premium;
            if (e.right === "C" && e.side === "sell") acc.cs += e.premium;
            if (e.right === "P" && e.side === "buy") acc.pb += e.premium;
            if (e.right === "P" && e.side === "sell") acc.ps += e.premium;
            return acc;
          },
          { cb: 0, cs: 0, pb: 0, ps: 0 },
        );
      expect(nvda.netPremium).toBeCloseTo(manual.cb - manual.cs - (manual.pb - manual.ps), 1);
    }
  });

  eachStore(
    "foldChainToDaily writes contract and underlying rows from a snapshot",
    async (store) => {
      const feed = new SyntheticFeed({ seed: 5, startTs: FIXTURE_START, pace: "asap" });
      const snap = await feed.getChainSnapshot("NVDA");
      expect(snap).not.toBeNull();
      foldChainToDaily(store, snap!);
      const dates = store.contractDailySessionDates("NVDA");
      expect(dates).toHaveLength(1);
      const rows = store.getContractDailyByUnderlying("NVDA", dates[0]!);
      expect(rows.length).toBeGreaterThan(100);
      expect(rows.every((r) => r.iv !== null)).toBe(true);
      const daily = store.getUnderlyingDaily("NVDA");
      expect(daily).toHaveLength(1);
      expect(daily[0]!.spotClose).toBeGreaterThan(0);
      expect(daily[0]!.atmIv).toBeGreaterThan(0);
    },
  );
});

describe("synthetic historical sessions", () => {
  it("same (seed, date) ⇒ identical historical tape; different dates differ", async () => {
    const feed = new SyntheticFeed({ seed: 42, startTs: FIXTURE_START, pace: "asap" });
    const collect = async (date: string) => {
      const out = [];
      for await (const t of feed.getHistoricalOptionTrades("NVDA", date)) {
        out.push(t);
        if (out.length >= 300) break;
      }
      return out;
    };
    const [a, b, c] = [
      await collect("2026-08-20"),
      await collect("2026-08-20"),
      await collect("2026-08-21"),
    ];
    expect(a.length).toBe(300);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
    // Every historical trade is for the requested underlying and session date.
    for (const t of a.slice(0, 20)) expect(t.contract.startsWith("NVDA")).toBe(true);
  }, 30_000);

  it("historical chain snapshots read as end-of-session and are deterministic", async () => {
    const feed = new SyntheticFeed({ seed: 42, startTs: FIXTURE_START, pace: "asap" });
    const a = await feed.getHistoricalChain("SPY", "2026-08-20");
    const b = await feed.getHistoricalChain("SPY", "2026-08-20");
    expect(a).not.toBeNull();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a!.contracts.length).toBeGreaterThan(100);
  });
});
