/*
  Integration tests for the seven whale_* tools, end to end through a real
  MCP Client ↔ Server pair (the SDK's linked in-memory transports) over a
  flight recorder populated by the real engine on the deterministic synthetic
  tape. Asserts the payload contracts agents depend on: breakdowns always
  ship, the GEX convention is stated, errors are honest, replay never writes.
*/

import { resolveConfig } from "@luxalgo/whale-core";
import { beforeAll, describe, expect, it } from "vitest";
import { type Connected, callJson, connect, type Seeded, seedStore } from "./fixture.js";

const SIX_COMPONENTS = [
  "aggression",
  "premiumVsBaseline",
  "repetition",
  "urgency",
  "volOi",
  "volumeVsBaseline",
].sort();

let seeded: Seeded;
let session: Connected;

beforeAll(async () => {
  seeded = await seedStore();
  session = await connect(seeded.store, seeded.config);
  return async () => {
    await session.close();
    seeded.store.close();
  };
}, 120_000);

describe("tool listing", () => {
  it("exposes exactly the seven whale tools", async () => {
    const { tools } = await session.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "whale_event",
      "whale_gex",
      "whale_recent",
      "whale_replay",
      "whale_rules",
      "whale_status",
      "whale_top",
    ]);
  });

  it("descriptions never use the banned vocabulary", async () => {
    // The project bans the incumbent "(un)ordinary-activity" marketing stem in all
    // agent-facing text. One substring check covers the whole word family; the stem
    // is assembled here so this file stays clean of it too.
    const bannedStem = ["u", "sual"].join("");
    const { tools } = await session.client.listTools();
    for (const tool of tools) {
      const text = `${tool.description ?? ""} ${JSON.stringify(tool.inputSchema ?? {})}`;
      expect(text.toLowerCase()).not.toContain(bannedStem);
    }
  });
});

describe("whale_status", () => {
  it("reports counts, coverage, cold start, and available chains", async () => {
    const { isError, payload } = await callJson(session.client, "whale_status");
    expect(isError).toBe(false);
    expect(payload.live_engine).toBe(false); // nothing heartbeats in the fixture
    expect(payload.heartbeat_age_ms).toBeNull();
    expect(payload.ticks).toBe(seeded.ticks.length);
    expect(payload.events).toBe(seeded.events.length);
    expect(payload.first_tick_ts).toBeLessThanOrEqual(payload.last_tick_ts);
    expect(payload.cold_start).toBe(true); // no baseline sessions were saved
    expect(payload.baseline_sessions).toBe(0);
    expect(payload.rules).toBe(0);
    expect(payload.chains_available.map((c: { underlying: string }) => c.underlying)).toContain(
      "NVDA",
    );
  });
});

describe("whale_recent", () => {
  it("returns compact rows, newest first, default limit 25", async () => {
    const { payload } = await callJson(session.client, "whale_recent");
    expect(payload.count).toBe(25);
    expect(payload.events).toHaveLength(25);
    const ts = payload.events.map((e: { ts: number }) => e.ts);
    expect([...ts].sort((a, b) => b - a)).toEqual(ts);
    for (const event of payload.events) {
      expect(event.id).toBeTypeOf("string");
      expect(event.score).toBeTypeOf("number");
      expect(event).not.toHaveProperty("score_breakdown"); // compact on purpose
      expect(event).not.toHaveProperty("reasons");
    }
  });

  it("applies ticker, kind, and min_premium filters", async () => {
    const { payload } = await callJson(session.client, "whale_recent", {
      ticker: "NVDA",
      kind: "sweep",
      min_premium: 50_000,
      limit: 200,
    });
    expect(payload.count).toBeGreaterThan(0);
    for (const event of payload.events) {
      expect(event.underlying).toBe("NVDA");
      expect(event.kind).toBe("sweep");
      expect(event.premium).toBeGreaterThanOrEqual(50_000);
    }
  });
});

describe("whale_top", () => {
  it("ships the full six-component breakdown with raw inputs, sorted by score", async () => {
    const { payload } = await callJson(session.client, "whale_top", { limit: 10 });
    expect(payload.window.from).toBeLessThan(payload.window.to);
    expect(payload.count).toBeGreaterThan(0);
    const totals = payload.events.map((e: { score: number }) => e.score);
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
    for (const event of payload.events) {
      expect(event.score).toBeGreaterThanOrEqual(60); // default floor
      expect(event.score_breakdown.total).toBe(event.score);
      expect(Object.keys(event.score_breakdown.components).sort()).toEqual(SIX_COMPONENTS);
      for (const component of Object.values<any>(event.score_breakdown.components)) {
        expect(component).toHaveProperty("value");
        expect(component).toHaveProperty("weight");
        expect(component.raw).toBeTypeOf("object"); // the inputs are always shown
      }
      expect(Array.isArray(event.score_breakdown.missing)).toBe(true);
      expect(event.score_breakdown.coldStart).toBe(true); // fixture has no baselines
      expect(event.reasons.length).toBeGreaterThan(0);
    }
  });

  it("honors tickers and min_score", async () => {
    const { payload } = await callJson(session.client, "whale_top", {
      tickers: ["NVDA"],
      min_score: 40,
      limit: 5,
    });
    expect(payload.count).toBeGreaterThan(0);
    for (const event of payload.events) {
      expect(event.underlying).toBe("NVDA");
      expect(event.score).toBeGreaterThanOrEqual(40);
    }
  });
});

describe("whale_event", () => {
  it("tells one event's complete story, legs with the NBBO used at print time", async () => {
    const recent = await callJson(session.client, "whale_recent", { kind: "sweep", limit: 1 });
    const id = recent.payload.events[0].id;
    const { isError, payload } = await callJson(session.client, "whale_event", { id });
    expect(isError).toBe(false);
    expect(payload.id).toBe(id);
    expect(payload.kind).toBe("sweep");
    expect(Object.keys(payload.score_breakdown.components).sort()).toEqual(SIX_COMPONENTS);
    expect(payload.reasons.length).toBeGreaterThan(0);
    expect(payload.legs_detail.length).toBe(payload.legs);
    expect(payload.legs_detail.length).toBeGreaterThan(1); // sweeps have 2+ legs
    for (const leg of payload.legs_detail) {
      expect(leg).toHaveProperty("nbbo_at_print"); // the flight-recorder guarantee
      expect(leg).toHaveProperty("conditions");
      expect(leg.exchange).toBeTypeOf("string");
    }
  });

  it("errors honestly on an unknown id", async () => {
    const { isError, payload } = await callJson(session.client, "whale_event", {
      id: "not-a-real-id",
    });
    expect(isError).toBe(true);
    expect(payload.error).toContain("not-a-real-id");
  });
});

describe("whale_gex", () => {
  it("returns the ladder and states the convention as an assumption", async () => {
    const { isError, payload } = await callJson(session.client, "whale_gex", {
      underlying: "NVDA",
    });
    expect(isError).toBe(false);
    expect(payload.snapshot_age_ms).toBeTypeOf("number");
    expect(payload.gex.underlying).toBe("NVDA");
    expect(payload.gex.convention).toBe(seeded.config.greeks.gexConvention);
    expect(payload.gex.conventionNote).toContain("assumption");
    expect(payload.gex.perStrike.length).toBeGreaterThan(0);
    for (const row of payload.gex.perStrike.slice(0, 5)) {
      expect(row).toHaveProperty("callGex");
      expect(row).toHaveProperty("putGex");
      expect(row).toHaveProperty("netGex");
    }
    expect(payload.gex.totalGex).toBeTypeOf("number");
  });

  it("restricts to one expiry when asked", async () => {
    const all = await callJson(session.client, "whale_gex", { underlying: "NVDA" });
    const expiry = all.payload.gex.expiriesIncluded[0];
    const one = await callJson(session.client, "whale_gex", { underlying: "NVDA", expiry });
    expect(one.payload.gex.expiriesIncluded).toEqual([expiry]);
  });

  it("errors honestly when no chain snapshot exists", async () => {
    const { isError, payload } = await callJson(session.client, "whale_gex", {
      underlying: "ZZZZ",
    });
    expect(isError).toBe(true);
    expect(payload.error).toContain("ZZZZ");
    expect(payload.error).toContain("chains_available");
  });
});

describe("whale_rules", () => {
  const rule = {
    id: "test-nvda-sweeps",
    match: { tickers: ["NVDA"], kind: ["sweep"], minScore: 75, minPremium: 250_000 },
    sink: { type: "stdout" },
  };

  it("add → list → remove roundtrip, persisted as source 'dynamic'", async () => {
    const empty = await callJson(session.client, "whale_rules", { action: "list" });
    expect(empty.payload.rules).toEqual([]);

    const added = await callJson(session.client, "whale_rules", { action: "add", rule });
    expect(added.isError).toBe(false);
    expect(added.payload).toEqual({ ok: true, added: "test-nvda-sweeps" });

    const listed = await callJson(session.client, "whale_rules", { action: "list" });
    expect(listed.payload.rules).toHaveLength(1);
    expect(listed.payload.rules[0].id).toBe("test-nvda-sweeps");
    expect(listed.payload.rules[0].source).toBe("dynamic");
    expect(listed.payload.rules[0].enabled).toBe(true); // schema default applied
    expect(seeded.store.listRules()).toHaveLength(1); // persisted, not in-memory

    const removed = await callJson(session.client, "whale_rules", {
      action: "remove",
      id: "test-nvda-sweeps",
    });
    expect(removed.payload).toEqual({ ok: true, removed: "test-nvda-sweeps" });
    const after = await callJson(session.client, "whale_rules", { action: "list" });
    expect(after.payload.rules).toEqual([]);
  });

  it("rejects an invalid rule with the schema issues", async () => {
    const { isError, payload } = await callJson(session.client, "whale_rules", {
      action: "add",
      rule: { id: "bad", sink: { type: "carrier-pigeon" } },
    });
    expect(isError).toBe(true);
    expect(payload.error).toContain("invalid rule");
    expect(payload.error).toContain("sink");
  });

  it("errors on add without a rule and on removing an unknown id", async () => {
    const noRule = await callJson(session.client, "whale_rules", { action: "add" });
    expect(noRule.isError).toBe(true);
    const noId = await callJson(session.client, "whale_rules", {
      action: "remove",
      id: "never-existed",
    });
    expect(noId.isError).toBe(true);
    expect(noId.payload.error).toContain("never-existed");
  });
});

describe("whale_replay", () => {
  function fullWindow() {
    const ts = seeded.ticks.map((t) => t.ts);
    return { from: Math.floor(Math.min(...ts)), to: Math.ceil(Math.max(...ts)) + 1 };
  }

  it("same config ⇒ empty diff (the determinism contract through MCP)", async () => {
    expect(seeded.events.length).toBeLessThan(1000); // fixture must stay under the diff cap
    const { isError, payload } = await callJson(session.client, "whale_replay", fullWindow());
    expect(isError).toBe(false);
    expect(payload.ticks_replayed).toBe(seeded.ticks.length);
    expect(payload.events_replayed).toBe(seeded.events.length);
    expect(payload.events_stored).toBe(seeded.events.length);
    expect(payload.added).toEqual([]);
    expect(payload.removed).toEqual([]);
    expect(payload.score_changed).toEqual([]);
    expect(payload.note).toContain("never re-fires");
  });

  it("never writes to the store", async () => {
    const before = seeded.store.status();
    await callJson(session.client, "whale_replay", fullWindow());
    const after = seeded.store.status();
    expect(after.ticks).toBe(before.ticks);
    expect(after.events).toBe(before.events);
    expect(after.rules).toBe(before.rules);
    expect(after.alertsFired).toBe(before.alertsFired);
    expect(after.lastEventTs).toBe(before.lastEventTs);
  });

  it("a raised emit floor shows up as removed events, none added", async () => {
    const raised = await connect(
      seeded.store,
      resolveConfig({ engine: { emit: { minPremium: 50_000 } } }),
    );
    try {
      const { payload } = await callJson(raised.client, "whale_replay", fullWindow());
      expect(payload.added).toEqual([]);
      expect(payload.removed.length).toBeGreaterThan(0);
      expect(payload.events_replayed).toBeLessThan(payload.events_stored);
    } finally {
      await raised.close();
    }
  });

  it("changed weights show up as score_changed, same events", async () => {
    const reweighted = await connect(
      seeded.store,
      resolveConfig({ score: { weights: { aggression: 0.6, volumeVsBaseline: 0.05 } } }),
    );
    try {
      const { payload } = await callJson(reweighted.client, "whale_replay", fullWindow());
      expect(payload.added).toEqual([]);
      expect(payload.removed).toEqual([]);
      expect(payload.score_changed.length).toBeGreaterThan(0);
      for (const change of payload.score_changed) {
        expect(change.stored_score).not.toBe(change.replayed_score);
        expect(change.id).toBeTypeOf("string");
        expect(change.contract).toBeTypeOf("string");
      }
    } finally {
      await reweighted.close();
    }
  });

  it("rejects an inverted window and one over seven days", async () => {
    const inverted = await callJson(session.client, "whale_replay", { from: 100, to: 50 });
    expect(inverted.isError).toBe(true);
    const { from } = fullWindow();
    const tooLong = await callJson(session.client, "whale_replay", {
      from,
      to: from + 8 * 86_400_000,
    });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.payload.error).toContain("7 days");
  });
});
