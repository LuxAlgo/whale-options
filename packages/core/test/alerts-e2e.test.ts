/*
  Alerts, end to end: rules seeded from config fire real HTTP sinks (a local
  server stands in for the webhook receiver and for a chat webhook), every
  fire lands in alerts_fired with its event id, and that id resolves back to
  the full stored event — the replayability guarantee for alerts.
*/

import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AlertDispatcher } from "../src/alerts/dispatcher.js";
import { alertRuleSchema } from "../src/config.js";
import { MemoryFlightRecorder } from "../src/store/memory.js";
import type { FlowEvent } from "../src/types.js";
import { collectSyntheticTicks, runEngineOver } from "./helpers.js";

interface Received {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  /** Exact bytes received — HMAC signatures verify over these, not a re-build. */
  raw: string;
}

let server: Server;
let port = 0;
const received: Received[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      received.push({
        path: req.url ?? "/",
        headers: req.headers,
        body: JSON.parse(raw),
        raw,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr && typeof addr === "object") port = addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("alerts end to end", () => {
  it("webhook + chat sinks fire over real HTTP, are recorded, and trace back to stored events", async () => {
    process.env.WHALE_TEST_WEBHOOK_SECRET = "e2e-secret";
    process.env.WHALE_DISCORD_WEBHOOK_URL = `http://127.0.0.1:${port}/discord`;

    const store = new MemoryFlightRecorder();
    store.upsertRule(
      alertRuleSchema.parse({
        id: "e2e-webhook",
        match: { minPremium: 100_000, excludeColdStart: false },
        sink: {
          type: "webhook",
          url: `http://127.0.0.1:${port}/hook`,
          secretEnv: "WHALE_TEST_WEBHOOK_SECRET",
          template: "flow-event",
        },
        cooldownSec: 0,
      }),
      "config",
    );
    store.upsertRule(
      alertRuleSchema.parse({
        id: "e2e-signal",
        match: { kind: ["sweep"], excludeColdStart: false },
        sink: {
          type: "webhook",
          url: `http://127.0.0.1:${port}/signal`,
          template: "order-signal",
        },
        cooldownSec: 0,
      }),
      "config",
    );
    store.upsertRule(
      alertRuleSchema.parse({
        id: "e2e-discord",
        match: { minPremium: 250_000, excludeColdStart: false },
        sink: { type: "discord" },
        cooldownSec: 0,
      }),
      "config",
    );

    const ticks = await collectSyntheticTicks({ seed: 31, maxEvents: 1500 });
    const events = runEngineOver(ticks);
    store.insertEvents(events);

    const dispatcher = new AlertDispatcher(store);
    let matched = 0;
    for (const event of events) matched += dispatcher.dispatch(event);
    await dispatcher.drain();

    expect(matched).toBeGreaterThan(0);
    expect(received.length).toBeGreaterThan(0);

    // Every fire is recorded, ok, and resolves to a stored event by id.
    const fired = store.listAlertsFired(1000);
    expect(fired.length).toBe(matched);
    for (const alert of fired) {
      expect(alert.ok).toBe(true);
      const event = store.getEvent(alert.eventId);
      expect(event).not.toBeNull();
      expect(event?.score.components).toBeDefined();
    }

    // flow-event template: full event with breakdown, HMAC valid over the wire bytes.
    const hook = received.filter((r) => r.path === "/hook");
    expect(hook.length).toBeGreaterThan(0);
    for (const r of hook) {
      const body = r.body as { source: string; alert: { ruleId: string }; event: FlowEvent };
      expect(body.source).toBe("whale-options");
      expect(body.alert.ruleId).toBe("e2e-webhook");
      expect(body.event.score.components.aggression).toBeDefined();
      const expected = createHmac("sha256", "e2e-secret").update(r.raw).digest("hex");
      expect(r.headers["x-whale-signature"]).toBe(expected);
    }

    // order-signal template: compact executor body.
    const signals = received.filter((r) => r.path === "/signal");
    expect(signals.length).toBeGreaterThan(0);
    for (const r of signals) {
      const body = r.body as { ticker: string; action: string; meta: { eventId: string } };
      expect(body.ticker).toMatch(/^[A-Z]+$/);
      expect(["buy", "sell"]).toContain(body.action);
      expect(store.getEvent(body.meta.eventId)).not.toBeNull();
    }

    // chat sink (discord-shaped): human-readable content line.
    const discord = received.filter((r) => r.path === "/discord");
    expect(discord.length).toBeGreaterThan(0);
    for (const r of discord) {
      const body = r.body as { content: string };
      expect(body.content).toContain("whale score");
    }
  }, 30_000);

  it("cooldown throttles repeat fires per rule+contract", async () => {
    const store = new MemoryFlightRecorder();
    store.upsertRule(
      alertRuleSchema.parse({
        id: "cooldown-rule",
        match: { excludeColdStart: false },
        sink: { type: "stdout" },
        cooldownSec: 3600,
      }),
      "config",
    );
    const ticks = await collectSyntheticTicks({ seed: 31, maxEvents: 400 });
    const events = runEngineOver(ticks).filter((e) => e.premium >= 10_000);
    const byContract = new Map<string, FlowEvent[]>();
    for (const e of events) {
      byContract.set(e.contract, [...(byContract.get(e.contract) ?? []), e]);
    }
    const repeat = [...byContract.values()].find((v) => v.length >= 2);
    expect(repeat).toBeDefined();
    const dispatcher = new AlertDispatcher(store);
    let matched = 0;
    for (const e of repeat ?? []) matched += dispatcher.dispatch(e);
    await dispatcher.drain();
    expect(matched).toBe(1); // second fire suppressed by the cooldown
  }, 30_000);
});
