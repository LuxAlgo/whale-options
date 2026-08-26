# MCP server (`@luxalgo/whale-mcp`)

whale-mcp gives any MCP client — Claude Code, Claude Desktop, or anything else that speaks the protocol — eyes on **your local flight recorder**: recent flow, top-scored events with full score breakdowns, single-event stories with the exact NBBO each print was judged against, GEX ladders, alert rules, deterministic replay, market-structure analytics (OI deltas, max pain, IV rank, net flow), score calibration, and cached FINRA short-volume context.

**Local-only by design.** Market-data entitlements are personal licenses, so the engine and this server run on your machine, against your feed, for you. There is no hosted mode and no multi-tenant anything; nothing is redistributed, and there is no telemetry. MIT.

## How it fits

```
whale run  ──writes──▶  .whale/whale.db (SQLite, WAL)  ◀──reads──  whale-mcp  ◀──MCP──  your agent
```

`whale run` is the single writer; whale-mcp reads the same SQLite file concurrently (WAL mode exists for exactly this). **Live data therefore needs a running engine** — without one you are querying a recording, which is often exactly what you want (yesterday's session replays fine). `whale_status` tells you which of the two you are looking at; agents should call it first.

## Installation

The examples use `--db` pointing at the engine's store (default `.whale/whale.db`, resolved from wherever `whale run` runs). Adjust the path to yours.

### Claude Code

```bash
claude mcp add whale-options -- npx -y @luxalgo/whale-mcp --db ~/.whale/whale.db
```

Or, against the HTTP transport (start `whale-mcp --http 8788` yourself, e.g. alongside the engine):

```bash
claude mcp add --transport http whale-options http://127.0.0.1:8788/mcp
```

### Claude Desktop

Settings → Developer → Edit Config, then add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "whale-options": {
      "command": "npx",
      "args": ["-y", "@luxalgo/whale-mcp", "--db", "/Users/you/.whale/whale.db"]
    }
  }
}
```

### Generic MCP clients

- **stdio** (default): have the client spawn `npx -y @luxalgo/whale-mcp --db <path>`. The server logs to stderr only; stdout carries the protocol.
- **Streamable HTTP**: run `whale-mcp --db <path> --http 8788` and point the client at `http://127.0.0.1:8788/mcp`.
- Debugging: `npx @modelcontextprotocol/inspector npx -y @luxalgo/whale-mcp --db <path>` gives you a UI to poke every tool.

## stdio vs `--http`

| | stdio (default) | `--http <port>` |
|---|---|---|
| Who starts it | The MCP client spawns it per session | You run it once; clients connect to `/mcp` |
| Good for | Claude Code / Desktop, one client | A long-lived server several local clients share |
| Sessions | One process per client | **Stateless**: every POST is self-contained; no session ids, no server-push stream (GET/DELETE answer 405) |
| Binding | n/a | `127.0.0.1` unless `--host` says otherwise |

The HTTP transport binds loopback by default. `--host 0.0.0.0` (or a LAN address) is available and the choice is yours — but this is a single-user server with no auth layer; it belongs on your machine or your LAN, never on the open internet.

## Flags & config

| Flag | Meaning |
|---|---|
| `--db <path>` | SQLite flight-recorder file (overrides the config's `store.path`) |
| `--config <path>` | Config file to load — **JSON only** (see below) |
| `--http <port>` | Streamable HTTP at `http://<host>:<port>/mcp` instead of stdio |
| `--host <addr>` | Bind address for `--http` (default `127.0.0.1`) |
| `-h, --help`, `--version` | Help text / version |

Precedence, highest wins: `--db` > `--config <file>` > `./whale.config.json` in the working directory > built-in defaults.

**JSON-only config, on purpose.** The CLI loads `whale.config.{ts,js}` through jiti; whale-mcp stays dependency-light and does not. A `whale.config.ts` is **not** read here — pass `--db` pointing at the same `store.path` (the one setting that matters most to a reader), or mirror the settings into `whale.config.json`. If a TS/JS config exists and no JSON one does, whale-mcp prints a note to stderr instead of silently running on defaults. Config matters beyond the db path in two places: `whale_replay` re-runs ticks under *this server's* config, and `whale_gex` takes `r`/`q`/`gexConvention` from it.

## Tool reference

Thirteen tools. Conventions that hold everywhere: premiums are dollars (price × size × 100, summed across legs); timestamps are epoch ms; scores run 0–100 and **always ship with their component breakdown** — transparency is the product; aggressor sides come from the NBBO stored at print time and `"unknown"` means the engine refused to guess. Honesty notes (window statements, statics-vs-predictions, emitted-events-only) ride in the payloads so agents can relay them — they are part of the result, not decoration.

> Every example response below comes from the seeded synthetic feed (`whale run --feed synthetic`) — no real market data appears in this document. Responses are truncated with `…` where long.

### `whale_status` — call this first

Health and provenance: is a live engine writing, how much is recorded, are baselines warm, which chains exist. The right first call in a session and the right reflex whenever another tool comes back empty.

```json
{ "name": "whale_status", "arguments": {} }
```

```jsonc
{
  "live_engine": false,          // no `whale run` heartbeat within ~15s — this is a recording
  "heartbeat_age_ms": null,
  "ticks": 2200,
  "events": 831,
  "first_tick_ts": 1787578200847,
  "last_tick_ts": 1787579091864,  // with first_tick_ts: the sane bounds for whale_replay
  "baseline_sessions": 0,
  "baseline_dates": [],
  "cold_start": true,             // scores carry wider uncertainty until baselines warm up
  "rules": 0,
  "alerts_fired": 0,
  "db_size_bytes": 3264512,
  "engine_stats": null,
  "chains_available": [{ "underlying": "NVDA", "ts": 1787579091864 }]
}
```

### `whale_recent` — the latest tape, compact

Newest-first rows for "what's flowing right now" questions. Filters: `ticker`, `kind` (`sweep | block | split | print`), `side` (`buy | sell | mid | unknown`), `min_premium` (dollars), `limit` (default 25). Rows are compact; the `id` feeds `whale_event`.

```json
{ "name": "whale_recent", "arguments": { "ticker": "NVDA", "kind": "sweep", "limit": 2 } }
```

```jsonc
{
  "count": 2,
  "events": [
    {
      "id": "ev_33d7e639d6200183",
      "ts": 1787579086690,
      "session_date": "2026-08-24",
      "underlying": "NVDA",
      "contract": "NVDA260911P00180000",
      "kind": "sweep",
      "side": "sell",
      "strike": 180, "right": "P", "expiry": "2026-09-11",
      "size": 778, "price": 3.1, "premium": 241180,
      "dte": 18.261, "otm_pct": 0.0575, "vol_oi": 0.324,
      "legs": 4, "exchanges": ["A", "M", "B", "X"],
      "score": 72.5, "cold_start": true
    },
    { "id": "ev_c546abe73634aec3", "contract": "NVDA260911C00177500", "kind": "sweep", "side": "sell", "premium": 1233237, "score": 78.1, "…": "…" }
  ]
}
```

### `whale_top` — highest-scored, breakdowns included

Ranked by score over a window (`window_minutes` back from the last recorded tick, default 390 = one session; `min_score` default 60; `tickers` to restrict; `limit` default 10). This is the "show your work" tool — every event carries the six-component decomposition with raw inputs, so an agent can *explain* the number instead of reciting it.

```json
{ "name": "whale_top", "arguments": { "tickers": ["NVDA"], "min_score": 60, "limit": 1 } }
```

```jsonc
{
  "window": { "from": 1787555691864, "to": 1787579091864 },
  "count": 1,
  "events": [
    {
      "id": "ev_33d839cf3c930025",
      "contract": "NVDA260904C00185000",
      "kind": "sweep", "side": "buy",
      "size": 896, "price": 9.6228, "premium": 862203,
      "dte": 11.263, "vol_oi": 2.003,
      "legs": 5, "exchanges": ["A", "H", "Z", "W", "B"],
      "score": 83.2, "cold_start": true,
      "score_breakdown": {
        "total": 83.2,
        "components": {
          "volumeVsBaseline": { "value": null, "weight": 0.2, "weighted": null,
            "raw": { "dayVolume": 1755, "avgDailyVolume": null },
            "note": "no volume baseline for this contract yet" },
          "premiumVsBaseline": { "value": 1, "weight": 0.2, "weighted": 25,
            "raw": { "premium": 862203, "percentile": 1, "samples": 364 } },
          "volOi": { "value": 0.6833, "weight": 0.15, "weighted": 12.81,
            "raw": { "dayVolume": 1755, "oi": 876, "ratio": 2.003, "capRatio": 4, "openingFlowLikely": "yes" } },
          "aggression": { "value": 1, "weight": 0.2, "weighted": 25,
            "raw": { "side": "buy", "throughQuote": "yes", "kind": "sweep", "isoCorroborated": "yes" } },
          "urgency": { "value": 0.1297, "weight": 0.1, "weighted": 1.62, "raw": { "…": "…" } },
          "repetition": { "value": 1, "weight": 0.15, "weighted": 18.75, "raw": { "…": "…" } }
        },
        "missing": ["volumeVsBaseline"],   // weights renormalize; the score never pretends
        "baselineDays": 0,
        "coldStart": true
      },
      "reasons": [
        "sweep: 5 legs across 5 exchanges in 266ms",
        "ISO-flagged legs corroborate an intermarket sweep",
        "aggressor buy: 9.62 at ask 9.62 (nbbo 9.46×9.62, 127ms old)",
        "cold start: 0/5 baseline sessions — score uncertainty is wider"
      ]
    }
  ]
}
```

### `whale_event` — one event's complete story

Everything about one `id`, including `legs_detail`: every print with its sale conditions and `nbbo_at_print` — the exact quote the aggressor call was judged against, stored at ingest. That stored-NBBO guarantee is the flight recorder's point: sides stay defensible after the fact. Unknown ids return an error with the id echoed.

```json
{ "name": "whale_event", "arguments": { "id": "ev_33d839cf3c930025" } }
```

```jsonc
{
  "id": "ev_33d839cf3c930025",
  "contract": "NVDA260904C00185000", "kind": "sweep", "side": "buy",
  "premium": 862203, "score": 83.2,
  "score_breakdown": { "…": "as in whale_top" },
  "reasons": ["sweep: 5 legs across 5 exchanges in 266ms", "…"],
  "legs_detail": [
    {
      "seq": 1699, "ts": 1787578882371, "exchange": "A",
      "price": 9.62, "size": 224, "conditions": ["iso"],
      "nbbo_at_print": { "bid": 9.46, "ask": 9.62, "bidSize": 24, "askSize": 57, "ts": 1787578882244 },
      "spot": 190.91, "oi": 876
    },
    { "seq": 1702, "exchange": "H", "price": 9.62, "size": 133, "conditions": ["iso"], "…": "…" }
  ]
}
```

### `whale_gex` — gamma exposure ladder

Per-strike dollar gamma per 1% spot move plus the zero-gamma level, for any underlying with a chain snapshot (`whale_status → chains_available`). Optional `expiry` restricts to one expiration. **The sign convention is an assumption about dealer positioning, not observed data** — the response says so itself, and agents should pass that along.

```json
{ "name": "whale_gex", "arguments": { "underlying": "NVDA" } }
```

```jsonc
{
  "snapshot_age_ms": 33483670,
  "gex": {
    "underlying": "NVDA",
    "spot": 191,
    "convention": "dealer-long-calls-short-puts",
    "conventionNote": "assumes dealers are long calls and short puts: call gamma positive, put gamma negative. This is an assumption about positioning, not observed data; flip via config gexConvention.",
    "expiriesIncluded": ["2026-08-28", "2026-09-04", "2026-09-11", "2026-09-18"],
    "perStrike": [
      { "strike": 185, "callGex": 5470284.29, "putGex": -3113404.68, "netGex": 2356879.61, "callOi": 7678, "putOi": 3272 },
      { "strike": 190, "callGex": 5557816.63, "putGex": -2867902.92, "netGex": 2689913.72, "callOi": 4706, "putOi": 2965 },
      { "strike": 195, "callGex": 1514911.49, "putGex": -5609925.59, "netGex": -4095014.1, "callOi": 2024, "putOi": 4743 },
      { "…": "…" }
    ],
    "totalGex": 2392144.25,
    "zeroGamma": { "level": 197.29, "method": "spot scan ±15% in 61 steps, linear interpolation at sign change; per-contract IV held fixed" },
    "skippedContracts": 0
  }
}
```

### `whale_rules` — alert rule CRUD

`action: "list" | "add" | "remove"`. Rules added here persist in the flight recorder as source `"dynamic"` and the live engine picks them up on its next event; rules from `whale.config.*` show as source `"config"` and are re-seeded every run (remove those in the file, not here). Sink credentials are env-var *names*, never raw secrets.

```json
{
  "name": "whale_rules",
  "arguments": {
    "action": "add",
    "rule": {
      "id": "nvda-big-sweeps",
      "match": { "tickers": ["NVDA"], "kind": ["sweep"], "minScore": 75, "minPremium": 250000 },
      "sink": { "type": "discord" }
    }
  }
}
```

```jsonc
{ "ok": true, "added": "nvda-big-sweeps" }

// action: "list" →
{ "rules": [{ "id": "nvda-big-sweeps", "enabled": true,
  "match": { "minScore": 75, "minPremium": 250000, "tickers": ["NVDA"], "kind": ["sweep"], "excludeColdStart": true },
  "sink": { "type": "discord" }, "cooldownSec": 60, "source": "dynamic" }] }

// action: "remove", id: "nvda-big-sweeps" →
{ "ok": true, "removed": "nvda-big-sweeps" }
```

Invalid rules come back with the schema issues verbatim (e.g. `invalid rule: sink: Invalid discriminator value…`), so an agent can fix and retry.

### `whale_replay` — what would today's config have flagged?

Re-runs stored ticks from `[from, to]` (epoch ms, ≤ 7 days) through the engine under the **current** config and diffs against what was recorded live. Ticks are self-contained and the engine is deterministic, so this is exactly what a live run with today's settings would have produced. **Replay never writes**: no events stored, no alerts re-fired.

```json
{ "name": "whale_replay", "arguments": { "from": 1787578200847, "to": 1787579091865 } }
```

```jsonc
{
  "ticks_replayed": 2200,
  "events_replayed": 831,
  "events_stored": 831,
  "added": [],          // current config would emit these; the live run didn't
  "removed": [],        // recorded live; gone under current config
  "score_changed": [],  // same events, different judgment: {id, contract, stored_score, replayed_score}
  "note": "replay never re-fires alerts; stored events are untouched. Differences mean the current config disagrees with the config that ran live."
}
```

All three lists empty ⇒ the running config agrees with the one that recorded the window (here: same config, byte-identical result — the determinism contract, live). One caveat: passing `underlying` replays a tape containing only that symbol, so tape-relative context (block thresholds from the size distribution, premium percentiles, repetition) is re-derived from the restricted tape and the diff can reflect *context*, not config. The authoritative diff replays the full window unrestricted.

### `whale_oi_deltas` — what changed overnight in a chain

Session-to-session open-interest change for one underlying, from the flight recorder's daily contract history — per contract ranked by |ΔOI|, aggregated per strike and per expiry. OI settles overnight, so session-to-session is the honest unit of change; deltas describe what changed in the data, never who opened the contracts or why, and summaries should stay that descriptive. Needs at least 2 recorded sessions of daily history — with fewer it returns empty lists and a `note` pointing at running the engine across sessions or `whale backfill`; relay that note instead of concluding nothing changed. Params: `underlying`; `sessions` (2 = latest vs previous, the default — the comparison is the window's endpoints, not day-by-day); `top` (max contract rows, default 20 — strike/expiry rollups always cover all qualifying contracts); `min_oi` (drop contracts whose OI never reached this on either session). `newContract: true` marks contracts with no row on the earlier session (`deltaPct` is null — there is no base).

```json
{ "name": "whale_oi_deltas", "arguments": { "underlying": "NVDA", "top": 2 } }
```

```jsonc
{
  "underlying": "NVDA",
  "fromDate": "2026-08-21",
  "toDate": "2026-08-24",
  "sessionsAvailable": 6,
  "contracts": [
    { "contract": "NVDA260904C00180000", "expiry": "2026-09-04", "strike": 180, "right": "C",
      "prevOi": 64, "currOi": 3773, "deltaOi": 3709, "deltaPct": 5795.31, "newContract": false },
    { "contract": "NVDA260911P00185000", "expiry": "2026-09-11", "strike": 185, "right": "P",
      "prevOi": 3566, "currOi": 413, "deltaOi": -3153, "deltaPct": -88.42, "newContract": false }
  ],
  "byStrike": [
    { "strike": 180, "prevOi": 3281, "currOi": 8484, "deltaOi": 5203 },
    { "…": "…" }
  ],
  "byExpiry": [{ "…": "…" }],
  "note": null
}
```

### `whale_max_pain` — per-expiry max-pain strike

The OI-weighted max-pain strike for each expiry: the candidate settlement price (evaluated at every listed strike) minimizing the total intrinsic value option holders would collect at expiration. **The response's `note` states that max pain is a static computed from current open interest — a description of where expiring would pay holders least, not a prediction of where price will go** — and it should be relayed every time the number is cited. Params: `underlying`; `expiry` (optional, one expiration; default all recorded). OI comes from the latest chain snapshot when one exists, else the latest daily session — `source` plus `asOfTs`/`sessionDate` say which, so stale data can be caveated. Empty `expiries` with a note means no chain data is recorded for the symbol (`whale_status → chains_available`).

```json
{ "name": "whale_max_pain", "arguments": { "underlying": "NVDA", "expiry": "2026-09-18" } }
```

```jsonc
{
  "underlying": "NVDA",
  "source": "chain-snapshot",
  "asOfTs": 1787578200000,
  "sessionDate": null,
  "spot": 190,
  "expiries": [
    { "expiry": "2026-09-18", "maxPainStrike": 187.5, "totalPayoutAtStrike": 24029000,
      "callOi": 12340, "putOi": 11058, "strikesEvaluated": 39, "spot": 190, "note": "…" }
  ],
  "note": "max pain is the strike minimizing total intrinsic value paid to option holders at expiration, OI-weighted (payout(S) = Σ calls OI×max(0,S−K)×100 + Σ puts OI×max(0,K−S)×100, evaluated at each listed strike) — a static computed from current open interest, not a prediction of where price will go"
}
```

### `whale_iv_rank` — IV rank over *recorded* history

Where the current ATM implied volatility sits inside recorded history: `ivRank = (current − min) / (max − min)`, `ivPercentile` = fraction of recorded sessions with ATM IV below today's, plus the raw current/min/max. **The window caveat is the point**: the conventional "IV rank" assumes a 52-week window, but the store only holds sessions the engine (or `whale backfill`) actually recorded — `historyDays` is the real window, and the `note` says so explicitly whenever it is under 60 sessions. Relay that note with any rank cited. `ivRank` is null when recorded min equals max (a flat or one-day history has no range); all-null with `historyDays: 0` means no ATM-IV history for the symbol yet. Param: `underlying`.

```json
{ "name": "whale_iv_rank", "arguments": { "underlying": "NVDA" } }
```

```jsonc
{
  "underlying": "NVDA",
  "currentIv": 0.45,
  "minIv": 0.45,
  "maxIv": 0.4506,
  "ivRank": 0,
  "ivPercentile": 0,
  "historyDays": 6,
  "firstDate": "2026-08-17",
  "lastDate": "2026-08-24",
  "note": "rank over 6 sessions, not a 52-week window"
}
```

### `whale_net_flow` — net premium leaderboard

Per-underlying net options premium over a lookback window, ranked by |netPremium|. Sign convention (also in the response `note`): `netPremium = (call buys − call sells) − (put buys − put sells)` — positive is bullish-tilted premium, negative bearish-tilted, a description of which side paid, not of anyone's intent. Two honesty notes to carry into summaries: this aggregates **emitted events only** (the engine's premium floor and emit policy apply — it reflects the recorded event tape, not total market volume), and sides come from NBBO comparison at print time, so unsided events count toward `events` but move no premium bucket. Params: `window_minutes` (lookback from the last recorded event, default 390 = one session); `top` (max rows, default 15 — `totals` always sums the whole window).

```json
{ "name": "whale_net_flow", "arguments": { "window_minutes": 390, "top": 2 } }
```

```jsonc
{
  "from": 1787554851644,
  "to": 1787578251644,
  "rows": [
    { "underlying": "SPY", "events": 15,
      "callBuyPremium": 202946, "callSellPremium": 475050,
      "putBuyPremium": 1165728, "putSellPremium": 53173,
      "callNet": -272104, "putNet": 1112555, "netPremium": -1384659 },
    { "underlying": "AMD", "events": 7, "callNet": 809891, "putNet": 45576, "netPremium": 764315, "…": "…" }
  ],
  "totals": { "underlyings": 5, "events": 50, "callNet": 879774, "putNet": 1735368, "netPremium": -855594, "…": "…" },
  "note": "netPremium = (call buys − call sells) − (put buys − put sells): positive is bullish-tilted premium. Aggregated from EMITTED events only (the engine's premium floor and emit policy apply), so this reflects the recorded event tape, not total market volume; sides come from NBBO comparison and unsided events count toward `events` but move no premium bucket."
}
```

### `whale_audit` — score calibration vs forward moves

Calibrates the whale scores **this** flight recorder produced against what the underlying actually did afterwards — a measurement of the user's own recorded tape, never a performance claim and never trading advice. The right tool for "do high scores mean anything on my data?". Params (all optional): `horizon` — `15m` | `1h` (forward spot from the recorder's own tick observations, within a 20-minute tolerance) | `eod` (the session's recorded close) | `1d` | `5d` (closes of recorded sessions after the event's — null when history is missing); default `1h`. `from`/`to` (epoch ms, default the full recorded range), `ticker`, `exclude_cold_start`. Returns a CalibrationReport: score-bin buckets plus `byKind` and `bySide` tables, each row carrying `n`, median/mean forward return of the **underlying**, `alignedPct` (the fraction where the underlying moved the event's way — an exact-zero move counts as not aligned), and `smallN` (n < 30 — read as noise); `excluded` counts mid/unknown-side and no-price-data events (excluded, counted, reported — never silently dropped); `baseRate` — the same numbers across all events with an outcome, the honest comparator alongside the 50% coin flip; and `caveats`, **always populated**. Non-negotiable when summarizing: relay the caveats with the numbers, compare buckets to `baseRate` rather than quoting `alignedPct` alone, and never present the output as a performance claim — option P&L is deliberately not computed (path- and spread-dependent; the caveats say why). If the caveats include the SYNTHETIC TAPE warning, outcomes are meaningless by construction and the run demonstrates the instrument only. Full methodology: [audit.md](audit.md).

```json
{ "name": "whale_audit", "arguments": { "horizon": "eod" } }
```

```jsonc
{
  "horizon": "eod",
  "window": { "from": 1787578200207, "to": 1787578254838 },
  "eventsConsidered": 50,
  "eventsWithOutcome": 45,
  "excluded": { "mid": 5, "unknown": 0, "noPriceData": 0 },
  "buckets": [
    { "label": "20–30", "n": 15, "medianFwdReturnPct": 0.0031, "meanFwdReturnPct": 0.0047, "alignedPct": 60, "smallN": true },
    { "…": "…" }
  ],
  "byKind": [{ "…": "…" }],
  "bySide": [{ "…": "…" }],
  "baseRate": { "alignedPct": 57.78, "medianFwdReturnPct": 0.0031 },
  "caveats": [
    "…",
    "SYNTHETIC TAPE — this window contains events from the seeded synthetic feed. Outcomes are meaningless by construction; this run demonstrates the instrument only."
  ]
}
```

### `whale_short_volume` — FINRA EOD short-sale context

Cached FINRA daily short-sale volume for one symbol — off-exchange trades reported to FINRA facilities, published end-of-day. Precision matters here and the tool's own description carries it: this is **not** real-time off-exchange data (nothing self-serve is), and short volume is **not** short interest — a one-day flow measure, not an outstanding-position count; market-maker hedging and liquidity provision print short structurally, so elevated ratios are the mechanical norm. The `note` in every response is the standing caveat and should be relayed (or faithfully paraphrased) whenever the numbers are. Interpretation discipline: compare a symbol against its own recent ratios, never a fixed threshold. This tool reads the local cache only — **no network**; an empty `days` means nothing is cached for the symbol, and syncing happens via the CLI (`whale context short-volume <symbol> --sync`), which the response's `hint` says. Params: `symbol`; `days` (weekdays of history, default 20, max 60). Full dataset guide: [context.md](context.md). (Response below invented to show the shape — FINRA rows are not committed to this repository.)

```json
{ "name": "whale_short_volume", "arguments": { "symbol": "NVDA", "days": 3 } }
```

```jsonc
{
  "symbol": "NVDA",
  "days": [
    { "sessionDate": "2026-08-20", "shortVolume": 1180000, "shortExemptVolume": 3900, "totalVolume": 2950000, "shortRatio": 0.4 },
    { "sessionDate": "2026-08-21", "shortVolume": 1425000, "shortExemptVolume": 4400, "totalVolume": 2810000, "shortRatio": 0.5071 },
    { "sessionDate": "2026-08-24", "shortVolume": 1200000, "shortExemptVolume": 4000, "totalVolume": 3000000, "shortRatio": 0.4 }
  ],
  "avg_short_ratio": 0.4357,
  "note": "FINRA consolidated short-sale volume: off-exchange trades reported to FINRA facilities, published end-of-day. A high short ratio is NOT a real-time dark-pool signal, and short volume is NOT short interest — market-maker hedging and liquidity provision print short structurally, so elevated ratios are the mechanical norm, not evidence of directional bets. End-of-day context only."
}
```

## The demo moment

User to their agent: **"anything sweeping NVDA today? how big a deal is it — show your work."**

1. `whale_status` → `live_engine: true`, `cold_start: true` (3 of 5 baseline sessions). The agent now knows to caveat.
2. `whale_top { "tickers": ["NVDA"], "min_score": 60 }` → the $862K call sweep above, score 83.2, breakdown attached.
3. The agent answers **from the components**, not the headline number:

> Yes — the standout is a buy sweep in the NVDA 2026-09-04 $185 calls: 896 contracts for $862K, filled as 5 legs across 5 exchanges in 266ms, every leg ISO-flagged. Whale score 83.2/100, and here's the work: aggression maxed (1.00 — every leg at or through the ask, 9.62 against a 9.46×9.62 quote), premium in the top percentile of comparable prints this session (1.00, n=364), volume/OI at 2.0 with open interest small enough that this looks like opening flow (0.68), repetition maxed (NVDA flow kept hitting the same way all morning), urgency modest (0.13 — 11 DTE, near the money). One component is missing: this contract has no 20-day volume baseline yet, so that weight was renormalized away rather than guessed — and the engine flags the whole score cold-start, meaning uncertainty is wider than it will be once baselines fill in. Want the leg-by-leg prints with the exact NBBO each was judged against (`whale_event ev_33d839cf3c930025`), or the gamma picture around $185–$200 (`whale_gex NVDA` — note its sign convention is a stated assumption)?

That answer cites every number it uses, keeps the cold-start caveat the engine itself attached, and offers the audit trail. That is the product working as intended: not "trust the score" but "here is the score's arithmetic".

## Notes

- **The engine must be running for live data.** `whale run` writes the flight recorder; whale-mcp reads the same SQLite file concurrently (WAL). Reading a recording is fully supported — `whale_status` tells you which you have.
- **Scores are transparent or they are nothing.** If an agent reports a score without components, that's a prompt problem, not a data problem — the breakdown is always in the payload.
- **GEX sign convention is an assumption**, stated in every response and flippable in config. Summaries should keep saying so.
- **Local-only, single-user.** No hosted mode, no multi-tenant anything, no auth layer — scope any `--host` widening accordingly.
- **MIT, no telemetry.** The server phones home to no one; the only I/O is your SQLite file and your MCP client.
