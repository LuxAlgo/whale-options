/*
  whale-mcp — MCP server over the Whale Options flight recorder. Local-only
  by design: feed entitlements are personal licenses, so the engine and this
  server run on the user's machine against the user's own data. Nothing is
  hosted, nothing is redistributed, no telemetry.

  Usage:
    whale-mcp                              stdio (default — what MCP clients spawn)
    whale-mcp --http 8788                  streamable HTTP at http://127.0.0.1:8788/mcp
    whale-mcp --http 8788 --host 0.0.0.0   bind beyond loopback (LAN use is your call)

  Config precedence (highest wins):
    1. --db <path>           SQLite flight-recorder file — overrides everything below
    2. --config <path>       explicit config file (JSON only — see next paragraph)
    3. ./whale.config.json   picked up from the working directory when present
    4. built-in defaults     (store at .whale/whale.db)

  JSON only, on purpose: the CLI loads whale.config.{ts,js} through jiti, but
  this package stays dependency-light and does not. A whale.config.ts is NOT
  read here — pass --db pointing at the same store.path, or mirror the
  settings into whale.config.json. When a TS/JS config exists and no JSON one
  does, a note goes to stderr so the mismatch is never silent.

  Live data needs a running engine: `whale run` writes the flight recorder;
  this server reads the same SQLite file concurrently (WAL). Logs go to
  stderr only — stdout belongs to the stdio transport.
*/

import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { resolveConfig, SqliteFlightRecorder, type WhaleConfig } from "@luxalgo/whale-core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MCP_PATH, startHttpServer } from "./http.js";
import { registerAuditTools } from "./tools/audit.js";
import { registerChartTools } from "./tools/chart.js";
import { registerContextTools } from "./tools/context.js";
import { registerMarketTools } from "./tools/market.js";
import { registerWhaleTools } from "./tools.js";

const VERSION = "0.1.0";

const HELP = `whale-mcp ${VERSION} — MCP server over your local Whale Options flight recorder

Transports
  (default)          stdio, for clients that spawn the server (Claude Code, Claude Desktop, ...)
  --http <port>      streamable HTTP at http://<host>:<port>${MCP_PATH} (stateless, POST only)
  --host <addr>      bind address for --http (default 127.0.0.1 — loopback; binding wider
                     is your choice: this is a single-user local server, keep it off the
                     open internet)

Data & config
  --db <path>        SQLite flight-recorder file (overrides the config's store.path)
  --config <path>    config file to load — JSON only. whale.config.ts/.js load through the
                     CLI's jiti loader, which this package deliberately does not depend on;
                     if you use a TS config, pass --db here (or mirror it to JSON).
  Precedence:        --db  >  --config <file>  >  ./whale.config.json  >  built-in defaults

Other
  -h, --help         this text
  --version          print the version

Live data needs a running engine: \`whale run\` writes the flight recorder; whale-mcp reads
the same SQLite file concurrently (WAL). MIT licensed, no telemetry. Docs: docs/mcp.md`;

interface CliArgs {
  db?: string;
  config?: string;
  http?: number;
  host: string;
  help: boolean;
  version: boolean;
}

function fail(message: string): never {
  console.error(`whale-mcp: ${message} (try --help)`);
  process.exit(1);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { host: "127.0.0.1", help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.indexOf("=");
    const flag = eq >= 0 ? raw.slice(0, eq) : raw;
    const value = (): string => {
      if (eq >= 0) return raw.slice(eq + 1);
      const next = argv[++i];
      if (next === undefined) fail(`${flag} needs a value`);
      return next;
    };
    switch (flag) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--version":
        args.version = true;
        break;
      case "--db":
        args.db = value();
        break;
      case "--config":
        args.config = value();
        break;
      case "--host":
        args.host = value();
        break;
      case "--http": {
        const port = Number(value());
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          fail(`--http needs a port between 1 and 65535, got '${port}'`);
        }
        args.http = port;
        break;
      }
      default:
        fail(`unknown argument '${raw}'`);
    }
  }
  return args;
}

const NON_JSON_CANDIDATES = [
  "whale.config.ts",
  "whale.config.mts",
  "whale.config.js",
  "whale.config.mjs",
];

/** JSON-only config loading; precedence documented in the file-top comment. */
function loadConfigForMcp(explicit: string | undefined): WhaleConfig {
  if (explicit) {
    const full = resolve(process.cwd(), explicit);
    if (!existsSync(full)) fail(`config file not found: ${full}`);
    if (!full.endsWith(".json")) {
      fail(
        `whale-mcp reads JSON config only, got '${basename(full)}' — TS/JS configs load through the CLI's jiti loader; mirror the settings into a .json file or pass --db <path>`,
      );
    }
    return resolveConfig(JSON.parse(readFileSync(full, "utf8")));
  }
  const fallback = resolve(process.cwd(), "whale.config.json");
  if (existsSync(fallback)) return resolveConfig(JSON.parse(readFileSync(fallback, "utf8")));
  const nonJson = NON_JSON_CANDIDATES.find((c) => existsSync(resolve(process.cwd(), c)));
  if (nonJson) {
    console.error(
      `whale-mcp: found ${nonJson} but this server reads JSON config only — running on defaults. Pass --db <path> (or mirror the settings into whale.config.json).`,
    );
  }
  return resolveConfig({});
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (args.version) {
  console.log(VERSION);
  process.exit(0);
}

let config: WhaleConfig;
try {
  config = loadConfigForMcp(args.config);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

const dbPath = args.db ?? config.store.path;
const store = new SqliteFlightRecorder(dbPath);
process.on("exit", () => {
  try {
    store.close();
  } catch {
    // already closed
  }
});

/** Fresh server per connection/request; tools close over the shared store + config. */
function buildServer(): McpServer {
  const server = new McpServer({ name: "whale-options", version: VERSION });
  registerWhaleTools(server, { store, config });
  registerMarketTools(server, { store, config });
  registerAuditTools(server, { store, config });
  registerContextTools(server, { store, config });
  registerChartTools(server, { store, config });
  return server;
}

if (args.http !== undefined) {
  const handle = await startHttpServer({ host: args.host, port: args.http, buildServer });
  console.error(
    `whale-mcp: streamable HTTP on http://${args.host}:${handle.port}${MCP_PATH} (db: ${dbPath})`,
  );
  const shutdown = () => {
    void handle.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} else {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}
