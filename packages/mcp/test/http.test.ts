/*
  Streamable HTTP transport, end to end: the real SDK client against the
  node:http server on an ephemeral loopback port. Stateless mode means every
  POST is self-contained — so two clients must work concurrently — and
  non-POST / wrong-path requests get honest JSON-RPC errors, not hangs.
*/

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeAll, describe, expect, it } from "vitest";
import { startHttpServer, type WhaleHttpHandle } from "../src/http.js";
import { registerWhaleTools } from "../src/tools.js";
import { callJson, type Seeded, seedStore } from "./fixture.js";

let seeded: Seeded;
let handle: WhaleHttpHandle;
let baseUrl: string;

async function httpClient(): Promise<Client> {
  const client = new Client({ name: "whale-mcp-http-tests", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
  return client;
}

beforeAll(async () => {
  seeded = await seedStore({ maxEvents: 300 });
  handle = await startHttpServer({
    host: "127.0.0.1",
    port: 0, // ephemeral
    buildServer: () => {
      const server = new McpServer({ name: "whale-options", version: "test" });
      registerWhaleTools(server, { store: seeded.store, config: seeded.config });
      return server;
    },
  });
  baseUrl = `http://127.0.0.1:${handle.port}`;
  return async () => {
    await handle.close();
    seeded.store.close();
  };
}, 120_000);

describe("streamable HTTP transport", () => {
  it("serves the same seven tools over HTTP", async () => {
    const client = await httpClient();
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(7);
      expect(tools.map((t) => t.name)).toContain("whale_top");
    } finally {
      await client.close();
    }
  });

  it("answers tool calls with the same payload contract as stdio", async () => {
    const client = await httpClient();
    try {
      const status = await callJson(client, "whale_status", {});
      expect(status.isError).toBe(false);
      expect(status.payload.ticks).toBe(seeded.ticks.length);
      expect(status.payload.events).toBe(seeded.events.length);
    } finally {
      await client.close();
    }
  });

  it("isolates concurrent clients (stateless: fresh server per request)", async () => {
    const [a, b] = await Promise.all([httpClient(), httpClient()]);
    try {
      const [ra, rb] = await Promise.all([
        callJson(a, "whale_recent", { limit: 5 }),
        callJson(b, "whale_recent", { limit: 5 }),
      ]);
      expect(ra.payload.count).toBe(5);
      expect(rb.payload.count).toBe(5);
      expect(ra.payload.events).toEqual(rb.payload.events); // same store, same answer
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });

  it("rejects non-POST methods and wrong paths with JSON-RPC errors", async () => {
    const get = await fetch(`${baseUrl}/mcp`);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    const getBody = (await get.json()) as { error: { message: string } };
    expect(getBody.error.message).toContain("POST only");

    const wrongPath = await fetch(`${baseUrl}/somewhere-else`, { method: "POST" });
    expect(wrongPath.status).toBe(404);
    const wrongBody = (await wrongPath.json()) as { error: { message: string } };
    expect(wrongBody.error.message).toContain("/mcp");
  });

  it("requires the spec's Accept header on POST (SDK-enforced)", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(406);
  });
});
