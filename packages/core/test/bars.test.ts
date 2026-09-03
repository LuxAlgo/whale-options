/*
  Underlying bars: the synthetic feed serves its own seeded spot walk as
  bars (deterministic, no volume, honest about its range), the vendor bar
  mappers translate invented vendor-shaped rows, and timeframe parsing
  accepts the chart's spellings.
*/
import { describe, expect, it } from "vitest";
import { mapAlpacaBar } from "../src/feeds/alpaca.js";
import { BAR_TIMEFRAME_MS, parseBarTimeframe } from "../src/feeds/bars.js";
import { mapMassiveAggregate } from "../src/feeds/massive.js";
import { SyntheticFeed } from "../src/feeds/synthetic.js";
import { easternTimeToUtc } from "../src/util/session.js";

const START = easternTimeToUtc("2026-08-24", 9, 30);

async function drain(feed: SyntheticFeed): Promise<number> {
  let n = 0;
  for await (const _ of feed.subscribeOptionTrades({})) n++;
  return n;
}

describe("synthetic underlying bars", () => {
  it("serves the spot walk as bars, deterministic per seed, volume null", async () => {
    const a = new SyntheticFeed({ seed: 9, startTs: START, maxEvents: 1200, pace: "asap" });
    const b = new SyntheticFeed({ seed: 9, startTs: START, maxEvents: 1200, pace: "asap" });
    await Promise.all([drain(a), drain(b)]);
    const range = { from: START, to: START + 3_600_000 };
    const ra = await a.getUnderlyingBars("NVDA", "1m", range);
    const rb = await b.getUnderlyingBars("NVDA", "1m", range);
    expect(ra).not.toBeNull();
    expect(ra?.bars.length ?? 0).toBeGreaterThan(3);
    expect(JSON.stringify(ra)).toBe(JSON.stringify(rb));
    expect(ra?.source).toContain("synthetic");
    expect(ra?.note).toContain("not exchange data");
    for (const bar of ra?.bars ?? []) {
      expect(bar.volume).toBeNull();
      expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close));
      expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close));
      expect(bar.ts % 60_000).toBe(0);
    }
    const ts = (ra?.bars ?? []).map((x) => x.ts);
    expect([...ts].sort((x, y) => x - y)).toEqual(ts);
  }, 30_000);

  it("folds to coarser timeframes and knows nothing about ranges it never walked", async () => {
    const feed = new SyntheticFeed({ seed: 9, startTs: START, maxEvents: 1200, pace: "asap" });
    await drain(feed);
    const range = { from: START, to: START + 3_600_000 };
    const one = await feed.getUnderlyingBars("SPY", "1m", range);
    const five = await feed.getUnderlyingBars("SPY", "5m", range);
    expect((five?.bars.length ?? 0) * 5).toBeGreaterThanOrEqual(one?.bars.length ?? 0);
    expect(five?.bars.every((b) => b.ts % 300_000 === 0)).toBe(true);
    expect(five?.bars[0]?.open).toBe(one?.bars[0]?.open);
    const before = await feed.getUnderlyingBars("SPY", "1m", {
      from: START - 86_400_000,
      to: START - 3_600_000,
    });
    expect(before?.bars).toEqual([]);
    expect(await feed.getUnderlyingBars("ZZZZ", "1m", range)).toBeNull();
  }, 30_000);

  it("the bars ARE the path the prints rode on", async () => {
    const feed = new SyntheticFeed({ seed: 9, startTs: START, maxEvents: 600, pace: "asap" });
    const spots: Array<{ ts: number; spot: number }> = [];
    for await (const raw of feed.subscribeOptionTrades({ underlyings: ["NVDA"] })) {
      if (raw.spot !== null && raw.spot !== undefined) spots.push({ ts: raw.ts, spot: raw.spot });
    }
    const last = spots[spots.length - 1];
    const bars = (
      await feed.getUnderlyingBars("NVDA", "1m", { from: START, to: START + 86_400_000 })
    )?.bars;
    const minute = bars?.find((b) => b.ts === Math.floor((last?.ts ?? 0) / 60_000) * 60_000);
    expect(minute).toBeDefined();
    expect(last?.spot ?? 0).toBeGreaterThanOrEqual(minute?.low ?? Number.POSITIVE_INFINITY);
    expect(last?.spot ?? 0).toBeLessThanOrEqual(minute?.high ?? Number.NEGATIVE_INFINITY);
  }, 30_000);
});

describe("vendor bar mappers (invented, vendor-shaped rows)", () => {
  it("alpaca: RFC3339 open time, o/h/l/c/v", () => {
    const bar = mapAlpacaBar({
      t: "2026-08-24T13:30:00Z",
      o: 190.1,
      h: 190.9,
      l: 189.8,
      c: 190.5,
      v: 12345,
      n: 210,
      vw: 190.4,
    });
    expect(bar).toEqual({
      ts: Date.parse("2026-08-24T13:30:00Z"),
      open: 190.1,
      high: 190.9,
      low: 189.8,
      close: 190.5,
      volume: 12345,
    });
    expect(mapAlpacaBar({ t: "2026-08-24T13:30:00Z", o: 1, h: 1, l: 1 })).toBeNull();
    expect(mapAlpacaBar({ o: 1, h: 1, l: 1, c: 1 })).toBeNull();
  });

  it("massive: unix-ms window start, o/h/l/c/v; volume null when absent", () => {
    const bar = mapMassiveAggregate({
      t: 1_787_578_200_000,
      o: 190.1,
      h: 190.9,
      l: 189.8,
      c: 190.5,
      v: 4321,
      vw: 190.3,
      n: 88,
    });
    expect(bar).toEqual({
      ts: 1_787_578_200_000,
      open: 190.1,
      high: 190.9,
      low: 189.8,
      close: 190.5,
      volume: 4321,
    });
    expect(mapMassiveAggregate({ t: 1, o: 1, h: 1, l: 1, c: 1 })?.volume).toBeNull();
    expect(mapMassiveAggregate({ o: 1, h: 1, l: 1, c: 1 })).toBeNull();
  });
});

describe("timeframe parsing", () => {
  it("accepts the chart's spellings and rejects the rest", () => {
    expect(parseBarTimeframe("1m")).toBe("1m");
    expect(parseBarTimeframe("1")).toBe("1m");
    expect(parseBarTimeframe("5")).toBe("5m");
    expect(parseBarTimeframe("15m")).toBe("15m");
    expect(parseBarTimeframe("60")).toBe("1h");
    expect(parseBarTimeframe("1D")).toBe("1d");
    expect(parseBarTimeframe(null)).toBe("1m");
    expect(parseBarTimeframe("2m")).toBeNull();
    expect(BAR_TIMEFRAME_MS["1h"]).toBe(3_600_000);
  });
});
