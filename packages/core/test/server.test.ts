/*
  The HTTP read surface for the chart: /api/bars says which source it used
  (feed bars vs the spot tape from prints), /api/flow serves the per-print
  series with its note, and /api/flow/sessions lists what is recorded. Runs
  the real server on an ephemeral loopback port over an in-memory store.
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SyntheticFeed } from "../src/feeds/synthetic.js";
import { FlowSeriesAggregator } from "../src/flow/series.js";
import { normalizeTrade } from "../src/normalize/normalize.js";
import { createWhaleServer, type WhaleServer } from "../src/server/server.js";
import { MemoryFlightRecorder } from "../src/store/memory.js";
import { easternTimeToUtc } from "../src/util/session.js";
import { testConfig } from "./helpers.js";

const START = easternTimeToUtc("2026-08-24", 9, 30);
let server: WhaleServer;
let base: string;
const store = new MemoryFlightRecorder();
const feed = new SyntheticFeed({ seed: 3, startTs: START, maxEvents: 1500, pace: "asap" });

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

/** Ephemeral loopback port: the schema floors port at 1, so set 0 after resolving. */
function serverConfig() {
  const config = testConfig({ server: { host: "127.0.0.1" } });
  config.server.port = 0;
  return config;
}

beforeAll(async () => {
  const config = serverConfig();
  const agg = new FlowSeriesAggregator({
    bucketMs: 60_000,
    nbboStaleMs: config.engine.nbboStaleMs,
    r: 0.05,
    q: 0,
  });
  let seq = 0;
  for await (const raw of feed.subscribeOptionTrades({})) {
    const { tick } = normalizeTrade(raw, "synthetic", seq++, (c) => feed.normalizeCondition(c));
    if (tick) agg.push(tick);
  }
  store.upsertFlowBuckets(agg.drainDirty());
  const chain = await feed.getChainSnapshot("NVDA");
  if (chain) store.upsertChainSnapshot(chain);
  server = createWhaleServer({ store, config, adapter: feed });
  const addr = await server.listen();
  expect(addr.port).toBeGreaterThan(0); // the bound ephemeral port, not the configured 0
  base = `http://${addr.host}:${addr.port}`;
}, 60_000);

afterAll(async () => {
  await server.close();
});

describe("GET /api/bars/:underlying", () => {
  it("serves the feed's bars and names the source", async () => {
    const { status, body } = await getJson("/api/bars/NVDA?tf=1m&session=2026-08-24");
    expect(status).toBe(200);
    expect(body.sourceKind).toBe("feed");
    expect(body.feed).toBe("synthetic");
    expect(body.source).toContain("synthetic");
    expect(body.bars.length).toBeGreaterThan(3);
    expect(body.timeframeMs).toBe(60_000);
    expect(body.note).toContain("not exchange data");
  });

  it("falls back to the spot tape from prints when the feed has nothing, and says so", async () => {
    // The synthetic walk never stepped through 2026-08-21, but the prints did
    // not either — so ask for the recorded session through a bar-less adapter.
    const bare = createWhaleServer({ store, config: serverConfig() });
    const addr = await bare.listen();
    try {
      const res = await fetch(
        `http://${addr.host}:${addr.port}/api/bars/NVDA?tf=5m&session=2026-08-24`,
      );
      const body = (await res.json()) as any;
      expect(res.status).toBe(200);
      expect(body.sourceKind).toBe("spot-tape");
      expect(body.source).toBe("spot-tape-from-prints");
      expect(body.note).toContain("SPOT TAPE FROM PRINTS");
      expect(body.note).toContain("no underlying-bar surface");
      expect(body.bars.length).toBeGreaterThan(0);
      expect(body.bars.every((b: { ts: number; volume: null }) => b.ts % 300_000 === 0)).toBe(true);
      expect(body.bars[0].volume).toBeNull();
    } finally {
      await bare.close();
    }
  });

  it("falls back when the feed returns no bars for the range", async () => {
    const { body } = await getJson("/api/bars/NVDA?tf=1m&session=2026-08-21");
    expect(body.sourceKind).toBe("spot-tape");
    expect(body.note).toContain("returned no bars");
    expect(body.bars).toEqual([]); // nothing printed that day either — honest empty
  });

  it("rejects an unknown timeframe and a malformed session", async () => {
    expect((await getJson("/api/bars/NVDA?tf=2m")).status).toBe(400);
    expect((await getJson("/api/bars/NVDA?session=yesterday")).status).toBe(400);
  });
});

describe("GET /api/flow", () => {
  it("lists recorded sessions and serves one underlying's series with the note", async () => {
    const sessions = await getJson("/api/flow/sessions?underlying=NVDA");
    expect(sessions.body.sessions).toEqual(["2026-08-24"]);
    expect(sessions.body.underlyings).toContain("NVDA");
    expect(sessions.body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const { status, body } = await getJson("/api/flow/NVDA/series?session=2026-08-24");
    expect(status).toBe(200);
    expect(body.series.underlying).toBe("NVDA");
    expect(body.series.bucketMs).toBe(60_000);
    expect(body.series.buckets.length).toBeGreaterThan(3);
    expect(body.series.note).toContain("premium floor");
    expect(body.series.deltaSource).toContain("Black-Scholes");
    const last = body.series.buckets[body.series.buckets.length - 1];
    expect(last.cumNetPremium).toBe(body.series.totals.netPremium);
    expect(last.cumNetVolume).toBe(body.series.totals.netVolume);
  });

  it("re-buckets on request and refuses a non-multiple", async () => {
    const five = await getJson("/api/flow/NVDA/series?session=2026-08-24&bucket=300000");
    expect(five.status).toBe(200);
    expect(five.body.series.bucketMs).toBe(300_000);
    expect(five.body.series.buckets.every((b: { ts: number }) => b.ts % 300_000 === 0)).toBe(true);
    expect((await getJson("/api/flow/NVDA/series?session=2026-08-24&bucket=90000")).status).toBe(
      400,
    );
  });

  it("an unrecorded session is an empty series, not an error", async () => {
    const { status, body } = await getJson("/api/flow/NVDA/series?session=2026-08-21");
    expect(status).toBe(200);
    expect(body.series.buckets).toEqual([]);
    expect(body.series.totals.prints).toBe(0);
  });
});

describe("GET /api/gex", () => {
  it("the ladder states its pricing; spot= re-prices and says when", async () => {
    const base = await getJson("/api/gex/NVDA");
    expect(base.status).toBe(200);
    expect(base.body.gex.pricing.spotSource).toBe("chain-snapshot");
    expect(base.body.gex.conventionNote).toContain("assumption");

    const spot = base.body.gex.spot * 1.02;
    const moved = await getJson(`/api/gex/NVDA?spot=${spot}`);
    expect(moved.status).toBe(200);
    expect(moved.body.gex.spot).toBeCloseTo(spot, 6);
    expect(moved.body.gex.pricing.spotSource).toBe("override");
    expect(moved.body.gex.pricing.note).toMatch(/^chain as of .*, re-priced at spot .* at /);
    expect(moved.body.gex.conventionNote).toBe(base.body.gex.conventionNote);
    expect((await getJson("/api/gex/NVDA?spot=-1")).status).toBe(400);
  });

  it("serves the strike-by-expiry heatmap with totals, spot row, and the notes", async () => {
    const { status, body } = await getJson("/api/gex/NVDA/heatmap?rows=9");
    expect(status).toBe(200);
    const heat = body.heatmap;
    expect(heat.strikes).toHaveLength(9);
    expect(heat.cells).toHaveLength(9);
    expect(heat.cells[0]).toHaveLength(heat.expiries.length);
    expect(heat.expiryTotals).toHaveLength(heat.expiries.length);
    expect(heat.spotRowIndex).toBeGreaterThanOrEqual(0);
    expect(heat.conventionNote).toContain("assumption");
    expect(heat.note).toContain("per 1% spot move");
    expect(heat.pricing.note).toContain("chain as of");
    expect((await getJson("/api/gex/ZZZZ/heatmap")).status).toBe(404);
  });
});
