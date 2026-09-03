/*
  Seeded fixture for the MCP integration tests: a real in-memory flight
  recorder populated by running the core Engine over the deterministic
  synthetic tape — the same pattern as core's determinism suite — so the MCP
  layer is exercised against exactly what a live `whale run` would have
  stored (ticks + events + a chain snapshot), with zero market data involved.
*/

import {
  Engine,
  easternTimeToUtc,
  type FlowEvent,
  FlowSeriesAggregator,
  normalizeTrade,
  type OptionTradeTick,
  resolveConfig,
  SqliteFlightRecorder,
  SyntheticFeed,
  type WhaleConfig,
  type WhaleConfigInput,
} from "@luxalgo/whale-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerChartTools } from "../src/tools/chart.js";
import { registerWhaleTools } from "../src/tools.js";

export const START = easternTimeToUtc("2026-08-24", 9, 30);

export interface Seeded {
  store: SqliteFlightRecorder;
  config: WhaleConfig;
  ticks: OptionTradeTick[];
  events: FlowEvent[];
}

/** Deterministic tape → engine → store. Default config emits ≲1000 events. */
export async function seedStore(
  opts: { seed?: number; maxEvents?: number; config?: WhaleConfigInput } = {},
): Promise<Seeded> {
  const feed = new SyntheticFeed({
    seed: opts.seed ?? 11,
    startTs: START,
    maxEvents: opts.maxEvents ?? 2200,
    pace: "asap",
    regime: "mixed",
  });
  const ticks: OptionTradeTick[] = [];
  let seq = 0;
  for await (const raw of feed.subscribeOptionTrades({})) {
    const { tick } = normalizeTrade(raw, "synthetic", seq, (c) => feed.normalizeCondition(c));
    if (tick) {
      ticks.push(tick);
      seq++;
    }
  }

  const config = resolveConfig(opts.config ?? {});
  const engine = new Engine(config);
  const events: FlowEvent[] = [];
  for (const t of ticks) events.push(...engine.push(t));
  events.push(...engine.flush());

  const store = new SqliteFlightRecorder(":memory:");
  store.insertTicks(ticks);
  store.insertEvents(events);
  const chain = await feed.getChainSnapshot("NVDA");
  if (chain) store.upsertChainSnapshot(chain);
  // The per-print flow series the runner would have persisted alongside.
  const flow = new FlowSeriesAggregator({
    bucketMs: config.flowSeries.bucketMs,
    nbboStaleMs: config.engine.nbboStaleMs,
    r: config.greeks.r,
    q: config.greeks.q,
  });
  for (const t of ticks) flow.push(t);
  store.upsertFlowBuckets(flow.drainDirty());

  return { store, config, ticks, events };
}

export interface Connected {
  client: Client;
  server: McpServer;
  close(): Promise<void>;
}

/** Real Client ↔ Server pair over the SDK's linked in-memory transports. */
export async function connect(
  store: SqliteFlightRecorder,
  config: WhaleConfig,
  opts: { chartTools?: boolean } = {},
): Promise<Connected> {
  const server = new McpServer({ name: "whale-options", version: "test" });
  registerWhaleTools(server, { store, config });
  if (opts.chartTools) registerChartTools(server, { store, config });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "whale-mcp-tests", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    server,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export interface ToolResult {
  isError: boolean;
  payload: any;
}

/** Call a tool and parse its single JSON text block. */
export async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  };
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (text === undefined) throw new Error(`tool ${name} returned no text content`);
  return { isError: result.isError === true, payload: JSON.parse(text) };
}
