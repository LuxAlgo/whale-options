/*
  Streamable HTTP transport for whale-mcp (--http <port>). One node:http
  server, stateless MCP: every POST /mcp gets a fresh McpServer + transport
  pair — the SDK's documented stateless pattern, since one shared pair would
  collide JSON-RPC request ids across concurrent clients. No sessions, no
  resumability, no GET stream: fine for a read-mostly, single-user server.
  Binds loopback by default; --host widens that, and doing so is the user's
  call — this is a local tool, never a hosted or multi-tenant service.
*/

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export const MCP_PATH = "/mcp";

export interface WhaleHttpOptions {
  host: string;
  /** TCP port; 0 picks an ephemeral port (tests). */
  port: number;
  /** Fresh McpServer per request — stateless mode isolates concurrent clients. */
  buildServer: () => McpServer;
}

export interface WhaleHttpHandle {
  server: Server;
  /** The bound port (differs from the requested one when it was 0). */
  port: number;
  close(): Promise<void>;
}

function rpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/** Start the streamable HTTP endpoint. Resolves once listening; rejects on bind failure. */
export function startHttpServer(opts: WhaleHttpOptions): Promise<WhaleHttpHandle> {
  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) {
        rpcError(res, 500, -32603, err instanceof Error ? err.message : String(err));
      } else {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== MCP_PATH) {
      rpcError(res, 404, -32000, `not found — the MCP endpoint is POST ${MCP_PATH}`);
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      rpcError(
        res,
        405,
        -32000,
        "method not allowed — this server is stateless: POST only, no GET stream, no DELETE sessions",
      );
      return;
    }
    const mcp = opts.buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session ids issued or required
      enableJsonResponse: true, // plain JSON responses; nothing here streams
    });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : opts.port;
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}
