/*
  Market-structure pack: OI deltas, max pain, IV rank, net-flow report.
  All hand-built or seeded-synthetic data; expected values computed by hand
  in the tests so the formulas are pinned, not just exercised. Empty-store
  paths must return honest notes, never throw.
*/
import { describe, expect, it } from "vitest";
import { ivRank } from "../src/market/iv-rank.js";
import { MAX_PAIN_NOTE, maxPain } from "../src/market/max-pain.js";
import { netFlowReport } from "../src/market/net-flow.js";
import { oiDeltas } from "../src/market/oi-deltas.js";
import { MemoryFlightRecorder } from "../src/store/memory.js";
import { SqliteFlightRecorder } from "../src/store/sqlite.js";
import type { ContractDailyRow, FlightRecorder } from "../src/store/types.js";
import type { ChainSnapshot } from "../src/types.js";
import { collectSyntheticTicks, runEngineOver } from "./helpers.js";

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

function dailyRow(
  overrides: Partial<ContractDailyRow> & Pick<ContractDailyRow, "contract" | "sessionDate">,
): ContractDailyRow {
  return {
    underlying: "NVDA",
    expiry: "2026-09-18",
    strike: 200,
    right: "C",
    oi: 1000,
    iv: 0.4,
    mid: 5,
    volume: 100,
    ...overrides,
  };
}

describe("oiDeltas", () => {
  eachStore("computes exact per-contract deltas, %s, and new-contract flags", (store) => {
    store.upsertContractDaily([
      // C200: 1000 → 1500 = +500 (+50%)
      dailyRow({ contract: "NVDA260918C00200000", sessionDate: "2026-08-21", oi: 1000 }),
      dailyRow({ contract: "NVDA260918C00200000", sessionDate: "2026-08-24", oi: 1500 }),
      // P190: 2000 → 1800 = −200 (−10%)
      dailyRow({
        contract: "NVDA260918P00190000",
        sessionDate: "2026-08-21",
        strike: 190,
        right: "P",
        oi: 2000,
      }),
      dailyRow({
        contract: "NVDA260918P00190000",
        sessionDate: "2026-08-24",
        strike: 190,
        right: "P",
        oi: 1800,
      }),
      // C210 appears only on the latest session: new to the chain, Δ = full OI.
      dailyRow({
        contract: "NVDA261016C00210000",
        sessionDate: "2026-08-24",
        expiry: "2026-10-16",
        strike: 210,
        oi: 800,
      }),
    ]);
    const result = oiDeltas(store, "nvda");
    expect(result.note).toBeNull();
    expect(result.fromDate).toBe("2026-08-21");
    expect(result.toDate).toBe("2026-08-24");
    expect(result.sessionsAvailable).toBe(2);

    // Ranked by |ΔOI|: new C210 (800), C200 (+500), P190 (−200).
    expect(result.contracts.map((c) => [c.contract, c.deltaOi, c.deltaPct, c.newContract])).toEqual(
      [
        ["NVDA261016C00210000", 800, null, true],
        ["NVDA260918C00200000", 500, 50, false],
        ["NVDA260918P00190000", -200, -10, false],
      ],
    );
    expect(result.contracts[1]!.prevOi).toBe(1000);
    expect(result.contracts[1]!.currOi).toBe(1500);

    // Strike rollup ranked by |ΔOI|; expiry rollup nets the September legs.
    expect(result.byStrike.map((s) => [s.strike, s.deltaOi])).toEqual([
      [210, 800],
      [200, 500],
      [190, -200],
    ]);
    expect(result.byExpiry.map((e) => [e.expiry, e.deltaOi, e.currOi])).toEqual(
      [
        ["2026-10-16", 800],
        ["2026-09-18", 300],
      ].map(([exp, d]) => [exp, d, exp === "2026-09-18" ? 3300 : 800]),
    );
  });

  eachStore("minOi filters dust and top caps the ranked list (aggregates keep all)", (store) => {
    store.upsertContractDaily([
      dailyRow({ contract: "NVDA260918C00200000", sessionDate: "2026-08-21", oi: 1000 }),
      dailyRow({ contract: "NVDA260918C00200000", sessionDate: "2026-08-24", oi: 1500 }),
      dailyRow({
        contract: "NVDA260918C00205000",
        sessionDate: "2026-08-21",
        strike: 205,
        oi: 10,
      }),
      dailyRow({
        contract: "NVDA260918C00205000",
        sessionDate: "2026-08-24",
        strike: 205,
        oi: 40,
      }),
      dailyRow({
        contract: "NVDA260918P00190000",
        sessionDate: "2026-08-21",
        strike: 190,
        right: "P",
        oi: 2000,
      }),
      dailyRow({
        contract: "NVDA260918P00190000",
        sessionDate: "2026-08-24",
        strike: 190,
        right: "P",
        oi: 1900,
      }),
    ]);
    const filtered = oiDeltas(store, "NVDA", { minOi: 100 });
    expect(filtered.contracts.map((c) => c.strike)).toEqual([200, 190]);
    const capped = oiDeltas(store, "NVDA", { top: 1 });
    expect(capped.contracts).toHaveLength(1);
    expect(capped.contracts[0]!.strike).toBe(200);
    // Aggregates cover all three contracts even when the list is capped.
    expect(capped.byStrike).toHaveLength(3);
  });

  eachStore("sessions option compares the endpoints of a longer window", (store) => {
    store.upsertContractDaily([
      dailyRow({ contract: "NVDA260918C00200000", sessionDate: "2026-08-20", oi: 400 }),
      dailyRow({ contract: "NVDA260918C00200000", sessionDate: "2026-08-21", oi: 1000 }),
      dailyRow({ contract: "NVDA260918C00200000", sessionDate: "2026-08-24", oi: 1500 }),
    ]);
    const result = oiDeltas(store, "NVDA", { sessions: 3 });
    expect(result.fromDate).toBe("2026-08-20");
    expect(result.toDate).toBe("2026-08-24");
    expect(result.contracts[0]!.deltaOi).toBe(1100);
    expect(result.contracts[0]!.deltaPct).toBe(275);
  });

  eachStore("single recorded session returns the honest insufficient-history note", (store) => {
    store.upsertContractDaily([
      dailyRow({ contract: "NVDA260918C00200000", sessionDate: "2026-08-24", oi: 1500 }),
    ]);
    const result = oiDeltas(store, "NVDA");
    expect(result.contracts).toEqual([]);
    expect(result.sessionsAvailable).toBe(1);
    expect(result.toDate).toBe("2026-08-24");
    expect(result.note).toContain(
      "need daily history; run the engine across sessions or `whale backfill`",
    );
  });

  eachStore("empty store returns a note instead of throwing", (store) => {
    const result = oiDeltas(store, "NVDA");
    expect(result.sessionsAvailable).toBe(0);
    expect(result.contracts).toEqual([]);
    expect(result.note).toContain("need daily history");
  });
});

describe("maxPain", () => {
  const snapshot: ChainSnapshot = {
    underlying: "NVDA",
    ts: Date.UTC(2026, 7, 24, 20, 0, 0),
    spot: 101,
    contracts: [
      {
        contract: "NVDA260918C00100000",
        underlying: "NVDA",
        expiry: "2026-09-18",
        strike: 100,
        right: "C",
        oi: 1000,
      },
      {
        contract: "NVDA260918C00110000",
        underlying: "NVDA",
        expiry: "2026-09-18",
        strike: 110,
        right: "C",
        oi: 500,
      },
      {
        contract: "NVDA260918P00100000",
        underlying: "NVDA",
        expiry: "2026-09-18",
        strike: 100,
        right: "P",
        oi: 800,
      },
      {
        contract: "NVDA260918P00090000",
        underlying: "NVDA",
        expiry: "2026-09-18",
        strike: 90,
        right: "P",
        oi: 600,
      },
      {
        contract: "NVDA260918P00110000",
        underlying: "NVDA",
        expiry: "2026-09-18",
        strike: 110,
        right: "P",
        oi: 100,
      },
    ],
  };

  // Hand-computed payout(S) = Σ calls OI×max(0,S−K)×100 + Σ puts OI×max(0,K−S)×100:
  //   S=90:  calls 0;                puts 800×10 + 100×20        → 1,000,000
  //   S=100: calls 0;                puts 100×10                 →   100,000
  //   S=110: calls 1000×10 → 10,000; puts 0                      → 1,000,000
  // Minimum at S=100 paying $100,000.
  eachStore("finds the exact minimizing strike on a hand-built chain", (store) => {
    store.upsertChainSnapshot(snapshot);
    const result = maxPain(store, "NVDA");
    expect(result.source).toBe("chain-snapshot");
    expect(result.asOfTs).toBe(snapshot.ts);
    expect(result.spot).toBe(101);
    expect(result.expiries).toHaveLength(1);
    const e = result.expiries[0]!;
    expect(e.expiry).toBe("2026-09-18");
    expect(e.maxPainStrike).toBe(100);
    expect(e.totalPayoutAtStrike).toBe(100_000);
    expect(e.callOi).toBe(1500);
    expect(e.putOi).toBe(1500);
    expect(e.strikesEvaluated).toBe(3);
    expect(e.note).toBe(MAX_PAIN_NOTE);
    expect(result.note).toContain("not a prediction");
  });

  eachStore("falls back to the latest contract_daily session and honors --expiry", (store) => {
    const rows = snapshot.contracts.map((c) =>
      dailyRow({
        contract: c.contract,
        sessionDate: "2026-08-24",
        expiry: c.expiry,
        strike: c.strike,
        right: c.right,
        oi: c.oi,
      }),
    );
    store.upsertContractDaily([
      ...rows,
      // A second expiry so the filter has something to exclude.
      dailyRow({
        contract: "NVDA261016C00120000",
        sessionDate: "2026-08-24",
        expiry: "2026-10-16",
        strike: 120,
        oi: 50,
      }),
    ]);
    store.upsertUnderlyingDaily([
      { underlying: "NVDA", sessionDate: "2026-08-24", spotClose: 101.5, atmIv: 0.4 },
    ]);
    const all = maxPain(store, "NVDA");
    expect(all.source).toBe("contract-daily");
    expect(all.sessionDate).toBe("2026-08-24");
    expect(all.spot).toBe(101.5);
    expect(all.expiries.map((e) => e.expiry)).toEqual(["2026-09-18", "2026-10-16"]);
    expect(all.expiries[0]!.maxPainStrike).toBe(100);

    const one = maxPain(store, "NVDA", "2026-09-18");
    expect(one.expiries.map((e) => e.expiry)).toEqual(["2026-09-18"]);
  });

  eachStore("empty store returns an honest note, not a throw", (store) => {
    const result = maxPain(store, "NVDA");
    expect(result.source).toBeNull();
    expect(result.expiries).toEqual([]);
    expect(result.note).toContain("no chain snapshot or daily contract history");
  });
});

describe("ivRank", () => {
  const day = (sessionDate: string, atmIv: number | null) => ({
    underlying: "NVDA",
    sessionDate,
    spotClose: 190,
    atmIv,
  });

  eachStore("monotonic rising series ranks 1.0 with percentile (N−1)/N", (store) => {
    store.upsertUnderlyingDaily([
      day("2026-08-18", 0.3),
      day("2026-08-19", 0.35),
      day("2026-08-20", 0.4),
      day("2026-08-21", 0.45),
      day("2026-08-24", 0.5),
    ]);
    const result = ivRank(store, "NVDA");
    expect(result.currentIv).toBe(0.5);
    expect(result.minIv).toBe(0.3);
    expect(result.maxIv).toBe(0.5);
    expect(result.ivRank).toBe(1);
    expect(result.ivPercentile).toBe(0.8); // 4 of 5 sessions below current
    expect(result.historyDays).toBe(5);
    expect(result.firstDate).toBe("2026-08-18");
    expect(result.lastDate).toBe("2026-08-24");
    expect(result.note).toBe("rank over 5 sessions, not a 52-week window");
  });

  eachStore("current at the recorded low ranks 0.0; null-IV days are excluded", (store) => {
    store.upsertUnderlyingDaily([
      day("2026-08-20", 0.6),
      day("2026-08-21", null), // no IV that day — must not count as history
      day("2026-08-22", 0.4),
      day("2026-08-24", 0.2),
    ]);
    const result = ivRank(store, "NVDA");
    expect(result.historyDays).toBe(3);
    expect(result.ivRank).toBe(0);
    expect(result.ivPercentile).toBe(0);
  });

  eachStore("interior value: exact rank and percentile math", (store) => {
    store.upsertUnderlyingDaily([
      day("2026-08-20", 0.2),
      day("2026-08-21", 0.6),
      day("2026-08-24", 0.3), // rank = (0.3−0.2)/(0.6−0.2) = 0.25; 1 of 3 below
    ]);
    const result = ivRank(store, "NVDA");
    expect(result.ivRank).toBe(0.25);
    expect(result.ivPercentile).toBe(0.3333);
  });

  eachStore("flat or single-day history has no range: rank null, note says why", (store) => {
    store.upsertUnderlyingDaily([day("2026-08-24", 0.42)]);
    const result = ivRank(store, "NVDA");
    expect(result.currentIv).toBe(0.42);
    expect(result.ivRank).toBeNull();
    expect(result.ivPercentile).toBe(0);
    expect(result.historyDays).toBe(1);
    expect(result.note).toContain("rank over 1 session, not a 52-week window");
    expect(result.note).toContain("rank is undefined");
  });

  eachStore("no IV history at all is null-safe with an honest note", (store) => {
    const result = ivRank(store, "NVDA");
    expect(result.currentIv).toBeNull();
    expect(result.ivRank).toBeNull();
    expect(result.ivPercentile).toBeNull();
    expect(result.historyDays).toBe(0);
    expect(result.note).toContain("no ATM IV history");
  });
});

describe("netFlowReport", () => {
  eachStore("rows mirror store.netFlow and totals sum every underlying", async (store) => {
    const ticks = await collectSyntheticTicks({ seed: 13, maxEvents: 800 });
    store.insertEvents(runEngineOver(ticks));
    const raw = store.netFlow(0, Number.MAX_SAFE_INTEGER);
    expect(raw.length).toBeGreaterThan(1);

    const report = netFlowReport(store, 0, Number.MAX_SAFE_INTEGER);
    expect(report.rows).toHaveLength(raw.length);
    for (const [i, row] of report.rows.entries()) {
      const base = raw[i]!;
      expect(row.underlying).toBe(base.underlying);
      expect(row.netPremium).toBe(base.netPremium);
      expect(row.callNet).toBeCloseTo(base.callBuyPremium - base.callSellPremium, 2);
      expect(row.putNet).toBeCloseTo(base.putBuyPremium - base.putSellPremium, 2);
      // Sign convention: (call buys − call sells) − (put buys − put sells).
      expect(row.netPremium).toBeCloseTo(row.callNet - row.putNet, 1);
    }
    expect(report.totals.underlyings).toBe(raw.length);
    expect(report.totals.events).toBe(raw.reduce((acc, r) => acc + r.events, 0));
    expect(report.totals.netPremium).toBeCloseTo(
      raw.reduce((acc, r) => acc + r.netPremium, 0),
      1,
    );
    expect(report.note).toContain("(call buys − call sells) − (put buys − put sells)");
    expect(report.note).toContain("EMITTED events only");

    // top caps the leaderboard but totals still cover the whole window.
    const capped = netFlowReport(store, 0, Number.MAX_SAFE_INTEGER, { top: 1 });
    expect(capped.rows).toHaveLength(1);
    expect(capped.totals.underlyings).toBe(raw.length);
  });

  eachStore("empty store yields zeroed totals and an honest note", (store) => {
    const report = netFlowReport(store, 0, Number.MAX_SAFE_INTEGER);
    expect(report.rows).toEqual([]);
    expect(report.totals).toEqual({
      underlyings: 0,
      events: 0,
      callBuyPremium: 0,
      callSellPremium: 0,
      putBuyPremium: 0,
      putSellPremium: 0,
      callNet: 0,
      putNet: 0,
      netPremium: 0,
    });
    expect(report.note).toContain("no events recorded in this window");
  });
});
