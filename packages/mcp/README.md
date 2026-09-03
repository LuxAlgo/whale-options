# @luxalgo/whale-mcp

MCP server over your local [whale-options](https://github.com/LuxAlgo/whale-options) flight recorder. It gives any MCP client (Claude Code, Claude Desktop, or anything that speaks the protocol) eyes on your own options-flow data: recent flow, top-scored events with full score breakdowns, single-event stories with the NBBO each print was judged against, GEX ladders, alert rules, and deterministic replay.

**Local-only by design.** Market-data entitlements are personal licenses, so the engine and this server run on your machine against your own data. Nothing is hosted, nothing is redistributed, no telemetry. MIT.

## Run

```bash
# stdio (default), what MCP clients spawn:
npx @luxalgo/whale-mcp --db ~/.whale/whale.db

# streamable HTTP on loopback:
npx @luxalgo/whale-mcp --db ~/.whale/whale.db --http 8788
# → endpoint: http://127.0.0.1:8788/mcp
```

Live data needs a running engine: `whale run` writes the flight recorder; whale-mcp reads the same SQLite file concurrently (WAL). Without a running engine you are reading a recording; `whale_status` tells you which.

## Flags

| Flag | Meaning |
|---|---|
| `--db <path>` | SQLite flight-recorder file (overrides the config's `store.path`) |
| `--config <path>` | Config file to load, **JSON only** (see below) |
| `--http <port>` | Serve streamable HTTP at `http://<host>:<port>/mcp` instead of stdio (stateless, POST only) |
| `--host <addr>` | Bind address for `--http` (default `127.0.0.1`; binding wider is your choice; single-user server, keep it off the open internet) |
| `-h, --help` / `--version` | Help text / version |

Precedence: `--db` > `--config <file>` > `./whale.config.json` > built-in defaults.

## Config is JSON-only here (on purpose)

The CLI loads `whale.config.{ts,js}` through jiti; this package stays dependency-light and does not. A `whale.config.ts` is **not** read by whale-mcp; pass `--db` pointing at the same `store.path`, or mirror the settings into `whale.config.json`. If a TS/JS config exists and no JSON one does, whale-mcp says so on stderr instead of silently running on defaults.

## The sixteen tools

`whale_status` · `whale_recent` · `whale_top` · `whale_event` · `whale_gex` · `whale_rules` · `whale_replay` · `whale_oi_deltas` · `whale_max_pain` · `whale_iv_rank` · `whale_net_flow` · `whale_audit` · `whale_short_volume` · `whale_flow_series` · `whale_bars` · `whale_gex_heatmap`

Every score ships with its six-component breakdown and raw inputs; transparency is the product. Full client setup (Claude Code, Claude Desktop, generic clients), a tool-by-tool reference with example calls, and a demo walkthrough: [docs/mcp.md](https://github.com/LuxAlgo/whale-options/blob/main/docs/mcp.md).
