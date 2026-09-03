/*
  The three chart-side tools, end to end through a real MCP Client ↔ Server
  pair over a recorder populated by the real engine and the real flow
  aggregator on the deterministic synthetic tape. Asserts the payload
  contracts agents depend on: the no-floor note and delta source ride the
  series, bars say they are the spot tape, the heatmap states both the
  convention assumption and its pricing provenance.
*/

import { beforeAll, describe, expect, it } from "vitest";
import { type Connected, callJson, connect, type Seeded, seedStore } from "./fixture.js";

let seeded: Seeded;
let session: Connected;

beforeAll(async () => {
  seeded = await seedStore();
  session = await connect(seeded.store, seeded.config, { chartTools: true });
  return async () => {
    await session.close();
    seeded.store.close();
  };
}, 120_000);

describe("tool listing with chart tools", () => {
  it("adds exactly the three chart tools", async () => {
    const { tools } = await session.client.listTools();
    expect(tools).toHaveLength(10);
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["whale_flow_series", "whale_bars", "whale_gex_heatmap"]),
    );
    const bannedStem = ["u", "sual"].join("");
    for (const tool of tools) {
      expect(`${tool.description ?? ""}`.toLowerCase()).not.toContain(bannedStem);
    }
  });
});

describe("whale_flow_series", () => {
  it("serves the session's buckets with cumulatives, totals, delta source, and the note", async () => {
    const { isError, payload } = await callJson(session.client, "whale_flow_series", {
      underlying: "NVDA",
    });
    expect(isError).toBe(false);
    expect(payload.underlying).toBe("NVDA");
    expect(payload.sessionDate).toBe("2026-08-24");
    expect(payload.bucketMs).toBe(60_000);
    expect(payload.buckets.length).toBeGreaterThan(3);
    expect(payload.buckets_total).toBe(payload.buckets.length);
    expect(payload.recorded_sessions).toEqual(["2026-08-24"]);
    const last = payload.buckets[payload.buckets.length - 1];
    expect(last.cumNetPremium).toBe(payload.totals.netPremium);
    expect(last.cumDirectionalDelta).toBe(payload.totals.directionalDelta);
    expect(payload.totals.unsided).toBeGreaterThan(0);
    expect(payload.deltaSource).toContain("Black-Scholes");
    expect(payload.note).toContain("premium floor");
    expect(payload.note).toContain("do NOT apply");
    expect(payload.note).toContain("SPOT TAPE FROM PRINTS");
  });

  it("re-buckets, limits, and refuses a non-integer width at the schema", async () => {
    const five = await callJson(session.client, "whale_flow_series", {
      underlying: "NVDA",
      bucket_minutes: 5,
      limit: 2,
    });
    expect(five.payload.bucketMs).toBe(300_000);
    expect(five.payload.buckets).toHaveLength(2);
    expect(five.payload.buckets_total).toBeGreaterThanOrEqual(2);
    await expect(
      callJson(session.client, "whale_flow_series", { underlying: "NVDA", bucket_minutes: 1.5 }),
    ).rejects.toThrow();
  });

  it("an unrecorded session is an honest empty series", async () => {
    const { payload } = await callJson(session.client, "whale_flow_series", {
      underlying: "NVDA",
      session_date: "2026-08-21",
    });
    expect(payload.buckets).toEqual([]);
    expect(payload.totals.prints).toBe(0);
    expect(payload.deltaSource).toContain("no sided prints");
  });
});

describe("whale_bars", () => {
  it("serves spot-tape bars and says exactly what they are", async () => {
    const { isError, payload } = await callJson(session.client, "whale_bars", {
      underlying: "NVDA",
      timeframe: "5m",
    });
    expect(isError).toBe(false);
    expect(payload.source).toBe("spot-tape-from-prints");
    expect(payload.timeframe_ms).toBe(300_000);
    expect(payload.bars.length).toBeGreaterThan(0);
    for (const bar of payload.bars) {
      expect(bar.ts % 300_000).toBe(0);
      expect(bar.volume).toBeNull();
      expect(bar.observations).toBeGreaterThan(0);
      expect(bar.high).toBeGreaterThanOrEqual(bar.low);
    }
    expect(payload.note).toContain("not exchange equity bars");
    expect(payload.note).toContain("/api/bars");
  });

  it("rejects an unknown timeframe and limits from the newest end", async () => {
    expect(
      (await callJson(session.client, "whale_bars", { underlying: "NVDA", timeframe: "2m" }))
        .isError,
    ).toBe(true);
    const all = await callJson(session.client, "whale_bars", {
      underlying: "NVDA",
      timeframe: "1m",
    });
    const tail = await callJson(session.client, "whale_bars", {
      underlying: "NVDA",
      timeframe: "1m",
      limit: 3,
    });
    expect(tail.payload.bars).toHaveLength(3);
    expect(tail.payload.bars[2].ts).toBe(all.payload.bars[all.payload.bars.length - 1].ts);
  });
});

describe("whale_gex_heatmap", () => {
  it("returns the grid with totals and states the convention and pricing", async () => {
    const { isError, payload } = await callJson(session.client, "whale_gex_heatmap", {
      underlying: "NVDA",
      rows: 7,
    });
    expect(isError).toBe(false);
    expect(payload.snapshot_age_ms).toBeTypeOf("number");
    const heat = payload.heatmap;
    expect(heat.strikes).toHaveLength(7);
    expect(heat.cells).toHaveLength(7);
    expect(heat.cells[0]).toHaveLength(heat.expiries.length);
    expect(heat.expiryTotals).toHaveLength(heat.expiries.length);
    expect(heat.strikeTotals).toHaveLength(7);
    expect(heat.spotRowIndex).toBeGreaterThanOrEqual(0);
    expect(heat.convention).toBe(seeded.config.greeks.gexConvention);
    expect(heat.conventionNote).toContain("assumption");
    expect(heat.pricing.spotSource).toBe("chain-snapshot");
    expect(heat.pricing.note).toContain("chain as of");
    expect(heat.note).toContain("per 1% spot move");
  });

  it("re-prices at a caller spot and says so; unknown names error honestly", async () => {
    const base = await callJson(session.client, "whale_gex_heatmap", { underlying: "NVDA" });
    const spot = base.payload.heatmap.spot * 1.03;
    const moved = await callJson(session.client, "whale_gex_heatmap", { underlying: "NVDA", spot });
    expect(moved.payload.heatmap.spot).toBeCloseTo(spot, 6);
    expect(moved.payload.heatmap.pricing.spotSource).toBe("override");
    expect(moved.payload.heatmap.pricing.note).toMatch(/re-priced at spot .* at /);
    expect(moved.payload.heatmap.conventionNote).toBe(base.payload.heatmap.conventionNote);
    const missing = await callJson(session.client, "whale_gex_heatmap", { underlying: "ZZZZ" });
    expect(missing.isError).toBe(true);
    expect(missing.payload.error).toContain("chains_available");
  });
});
