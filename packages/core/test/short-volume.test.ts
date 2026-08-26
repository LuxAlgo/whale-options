/*
  FINRA daily short-sale volume context: parser (header-tolerant, malformed
  lines and trailers skipped), sync (weekday walk-back, symbol filtering,
  cache-hit short-circuit, missing-file skips), and the report (ratio math,
  the always-present honesty note). Every FINRA-format sample here is
  invented; no real market data appears in this repository.
*/
import { describe, expect, it } from "vitest";
import {
  fetchShortVolumeDay,
  parseShortVolumeFile,
  recentWeekdays,
  SHORT_VOLUME_NOTE,
  ShortVolumeFileMissingError,
  shortVolumeFileUrl,
  shortVolumeReport,
  syncShortVolume,
} from "../src/context/short-volume.js";
import { MemoryFlightRecorder } from "../src/store/memory.js";

// Invented sample in the documented CNMS format: header, data rows, one
// malformed line, one trailer/record-count line.
const SAMPLE = [
  "Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market",
  "20260824|NVDA|1200000|4000|3000000|B,Q,N",
  "20260824|TSLA|550000|100|1000000|Q",
  "20260824|SPY|9000000|20000|20000000|B,Q",
  "20260824|BROKEN|not-a-number", // malformed — skipped
  "Trailer|4", // record-count footer — skipped
  "",
].join("\r\n");

describe("parseShortVolumeFile", () => {
  it("parses the documented format exactly, skipping the malformed line and trailer", () => {
    const rows = parseShortVolumeFile(SAMPLE, "finra-cnms");
    expect(rows).toEqual([
      {
        symbol: "NVDA",
        sessionDate: "2026-08-24",
        shortVolume: 1_200_000,
        shortExemptVolume: 4_000,
        totalVolume: 3_000_000,
        source: "finra-cnms",
      },
      {
        symbol: "TSLA",
        sessionDate: "2026-08-24",
        shortVolume: 550_000,
        shortExemptVolume: 100,
        totalVolume: 1_000_000,
        source: "finra-cnms",
      },
      {
        symbol: "SPY",
        sessionDate: "2026-08-24",
        shortVolume: 9_000_000,
        shortExemptVolume: 20_000,
        totalVolume: 20_000_000,
        source: "finra-cnms",
      },
    ]);
  });

  it("parses a headerless file in the documented column order", () => {
    const rows = parseShortVolumeFile("20260821|AMD|300|10|900|Q\n", "finra-cnms");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ symbol: "AMD", sessionDate: "2026-08-21", shortVolume: 300 });
  });

  it("follows a reordered header instead of assuming column positions", () => {
    const text = [
      "Symbol|Date|TotalVolume|ShortVolume|ShortExemptVolume|Market",
      "NVDA|20260824|3000000|1200000|4000|B",
    ].join("\n");
    const rows = parseShortVolumeFile(text, "finra-cnms");
    expect(rows).toEqual([
      {
        symbol: "NVDA",
        sessionDate: "2026-08-24",
        shortVolume: 1_200_000,
        shortExemptVolume: 4_000,
        totalVolume: 3_000_000,
        source: "finra-cnms",
      },
    ]);
  });

  it("returns [] for a header missing required columns", () => {
    expect(parseShortVolumeFile("Foo|Bar\nx|y\n", "finra-cnms")).toEqual([]);
  });
});

describe("shortVolumeFileUrl / recentWeekdays", () => {
  it("builds the documented CNMS file URL", () => {
    expect(shortVolumeFileUrl("2026-08-24")).toBe(
      "https://cdn.finra.org/equity/regsho/daily/CNMSshvol20260824.txt",
    );
    expect(shortVolumeFileUrl("2026-08-24", "http://localhost:9999/")).toBe(
      "http://localhost:9999/CNMSshvol20260824.txt",
    );
  });

  it("walks back weekdays only, oldest first", () => {
    // 2026-08-25 is a Tuesday; the walk-back must jump the 22nd/23rd weekend.
    expect(recentWeekdays("2026-08-25", 5)).toEqual([
      "2026-08-19",
      "2026-08-20",
      "2026-08-21",
      "2026-08-24",
      "2026-08-25",
    ]);
  });
});

/** Stub fetch serving an invented file per date; 404 for everything else. */
function stubFetch(filesByDate: Record<string, string>, calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const date = /CNMSshvol(\d{8})\.txt$/.exec(url)?.[1];
    const iso = date ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : "";
    const body = filesByDate[iso];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

function inventedFile(dateIso: string): string {
  const d = dateIso.replaceAll("-", "");
  return [
    "Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market",
    `${d}|NVDA|1200000|4000|3000000|B,Q,N`,
    `${d}|TSLA|550000|100|1000000|Q`,
    `${d}|OTHER|77|0|100|Q`, // not in the requested universe — must be filtered
    `Trailer|3`,
  ].join("\n");
}

describe("fetchShortVolumeDay", () => {
  it("throws ShortVolumeFileMissingError on 404 so callers can skip the date", async () => {
    const calls: string[] = [];
    await expect(
      fetchShortVolumeDay("2026-08-23", { fetchImpl: stubFetch({}, calls) }),
    ).rejects.toBeInstanceOf(ShortVolumeFileMissingError);
  });

  it("surfaces non-404 failures as plain errors with the status", async () => {
    const failing = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    await expect(fetchShortVolumeDay("2026-08-24", { fetchImpl: failing })).rejects.toThrow(
      /HTTP 500/,
    );
  });
});

describe("syncShortVolume", () => {
  const published = {
    "2026-08-19": inventedFile("2026-08-19"),
    "2026-08-20": inventedFile("2026-08-20"),
    "2026-08-21": inventedFile("2026-08-21"),
    "2026-08-24": inventedFile("2026-08-24"),
    // 2026-08-25 (today) not yet published -> 404 -> skipped
  };

  it("fetches missing weekdays, filters to the universe, and skips unpublished days", async () => {
    const store = new MemoryFlightRecorder();
    const calls: string[] = [];
    const result = await syncShortVolume({
      store,
      symbols: ["nvda", "TSLA"],
      days: 5,
      today: "2026-08-25",
      fetchImpl: stubFetch(published, calls),
    });

    expect(result.daysFetched).toBe(4);
    expect(result.daysSkipped).toEqual(["2026-08-25"]);
    expect(result.rowsStored).toBe(8); // 2 symbols × 4 published days

    // Weekend dates are never even attempted.
    expect(calls.some((u) => u.includes("20260822") || u.includes("20260823"))).toBe(false);
    expect(calls).toHaveLength(5); // 5 weekdays, one request each

    // Only the requested universe is stored; the file's OTHER row is dropped.
    expect(store.getShortVolume("NVDA")).toHaveLength(4);
    expect(store.getShortVolume("TSLA")).toHaveLength(4);
    expect(store.getShortVolume("OTHER")).toHaveLength(0);
    store.close();
  });

  it("short-circuits on cache hits: a resync refetches nothing already stored", async () => {
    const store = new MemoryFlightRecorder();
    const firstCalls: string[] = [];
    await syncShortVolume({
      store,
      symbols: ["NVDA", "TSLA"],
      days: 5,
      today: "2026-08-25",
      fetchImpl: stubFetch(published, firstCalls),
    });
    expect(firstCalls).toHaveLength(5);

    const secondCalls: string[] = [];
    const resync = await syncShortVolume({
      store,
      symbols: ["NVDA", "TSLA"],
      days: 5,
      today: "2026-08-25",
      fetchImpl: stubFetch(published, secondCalls),
    });
    // Only today (still unpublished, never cached) is retried.
    expect(secondCalls).toHaveLength(1);
    expect(secondCalls[0]).toContain("20260825");
    expect(resync.daysFetched).toBe(0);
    expect(resync.daysSkipped).toEqual([
      "2026-08-19",
      "2026-08-20",
      "2026-08-21",
      "2026-08-24",
      "2026-08-25",
    ]);
    expect(resync.rowsStored).toBe(0);
    store.close();
  });

  it("refetches a day when a newly added symbol is missing from its cache", async () => {
    const store = new MemoryFlightRecorder();
    await syncShortVolume({
      store,
      symbols: ["NVDA"],
      days: 2,
      today: "2026-08-24",
      fetchImpl: stubFetch(published, []),
    });
    const calls: string[] = [];
    const result = await syncShortVolume({
      store,
      symbols: ["NVDA", "TSLA"],
      days: 2,
      today: "2026-08-24",
      fetchImpl: stubFetch(published, calls),
    });
    expect(calls).toHaveLength(2); // TSLA uncached for both days -> both refetched
    expect(result.rowsStored).toBe(4); // both symbols re-upserted for both days
    expect(store.getShortVolume("TSLA")).toHaveLength(2);
    store.close();
  });

  it("propagates non-404 fetch failures instead of miscounting them as skips", async () => {
    const store = new MemoryFlightRecorder();
    const failing = (async () => new Response("boom", { status: 503 })) as typeof fetch;
    await expect(
      syncShortVolume({
        store,
        symbols: ["NVDA"],
        days: 1,
        today: "2026-08-24",
        fetchImpl: failing,
      }),
    ).rejects.toThrow(/HTTP 503/);
    store.close();
  });
});

describe("shortVolumeReport", () => {
  it("computes per-day ratios and the average, note always present", () => {
    const store = new MemoryFlightRecorder();
    store.upsertShortVolume([
      {
        symbol: "NVDA",
        sessionDate: "2026-08-21",
        shortVolume: 400,
        shortExemptVolume: 1,
        totalVolume: 1000,
        source: "finra-cnms",
      },
      {
        symbol: "NVDA",
        sessionDate: "2026-08-24",
        shortVolume: 600,
        shortExemptVolume: 2,
        totalVolume: 1000,
        source: "finra-cnms",
      },
      {
        symbol: "NVDA",
        sessionDate: "2026-08-25",
        shortVolume: 0,
        shortExemptVolume: 0,
        totalVolume: 0, // zero-volume day -> ratio null, excluded from the avg
        source: "finra-cnms",
      },
    ]);
    const report = shortVolumeReport(store, "nvda");
    expect(report.symbol).toBe("NVDA");
    expect(report.days.map((d) => [d.sessionDate, d.shortRatio])).toEqual([
      ["2026-08-21", 0.4],
      ["2026-08-24", 0.6],
      ["2026-08-25", null],
    ]);
    expect(report.avgShortRatio).toBeCloseTo(0.5, 12);
    expect(report.note).toBe(SHORT_VOLUME_NOTE);
    store.close();
  });

  it("empty cache: no days, null average, and the note still present", () => {
    const store = new MemoryFlightRecorder();
    const report = shortVolumeReport(store, "NVDA", 20);
    expect(report.days).toEqual([]);
    expect(report.avgShortRatio).toBeNull();
    expect(report.note.length).toBeGreaterThan(0);
    store.close();
  });

  it("the note states the substance: EOD, not dark-pool, not short interest", () => {
    expect(SHORT_VOLUME_NOTE).toMatch(/end-of-day/i);
    expect(SHORT_VOLUME_NOTE).toMatch(/NOT a real-time dark-pool signal/);
    expect(SHORT_VOLUME_NOTE).toMatch(/NOT short interest/);
    expect(SHORT_VOLUME_NOTE).toMatch(/market-maker hedging/i);
  });
});
