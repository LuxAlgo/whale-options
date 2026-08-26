# Feeds

Whale Options brings the detection; you bring the data. This page is the per-vendor setup guide, the adapter contract for contributors, and the canary system that keeps the vendor adapters honest.

Two rules hold everywhere:

- **Credentials are env vars only.** They are named after the vendor (so tools can share them), never invented per-project, never written into config files, and sent only to the vendor they authenticate. No telemetry, no middleman.
- **The engine treats every feed identically.** Adapters normalize vendor prints into self-contained ticks; from there classification, scoring, and replay are feed-agnostic. What differs per vendor is entitlement, enrichment coverage, and quirks — all listed below.

Entitlement notes describe each vendor's structure at the time of writing; prices and tier contents drift, so verify on the vendor's own pages before subscribing.

## At a glance

| Feed id | Stream | NBBO with trades | Greeks on chains | OI | Keys |
|---|---|---|---|---|---|
| `tradier` | real-time (funded account) | yes (bid/ask on timesales) | yes | yes | `TRADIER_ACCESS_TOKEN` |
| `thetadata` | real-time (by tier) | yes (terminal quote stream) | by tier | by tier | none (terminal holds auth) |
| `alpaca` | indicative free / OPRA paid | no — looked up per print | yes | **no** | `ALPACA_API_KEY_ID` + `ALPACA_API_SECRET_KEY` |
| `massive` | delayed entry / real-time advanced | no — looked up per print | yes | yes | `MASSIVE_API_KEY` (or `POLYGON_API_KEY`) |
| `synthetic` | seeded generator | yes | yes | yes | none |
| `replay` | your recorded tapes | yes (on the tape) | n/a | on the tape | none |

Where a vendor does not attach the NBBO to trades, the runner fetches it per print (cached ~2 s) *before* the engine sees the tick, so the stored tick is always self-contained. Where enrichment is missing entirely (e.g. no OI), the affected score component reports itself missing rather than guessing — see [scoring.md](scoring.md).

## Tradier

Brokerage market-data API: your broker connection is your data feed. Real-time market-data API access is included with a funded brokerage account — verify current scope on [Tradier's docs](https://documentation.tradier.com/). The sandbox has delayed REST and **no streaming**.

```bash
export TRADIER_ACCESS_TOKEN=...   # brokerage API access token
```

```ts
export default defineConfig({
  feed: { id: "tradier" },
  universe: { underlyings: ["SPY", "NVDA", "TSLA"] },  // REQUIRED for tradier
});
```

| Config key | Default | Notes |
|---|---|---|
| `feed.tradier.apiBase` | `https://api.tradier.com/v1` | point at `https://sandbox.tradier.com/v1` for sandbox REST testing (no streaming there) |

Specifics and quirks:

- **`universe.underlyings` is required.** Tradier streams concrete option symbols — there is no per-underlying wildcard and no full-market stream — so the adapter enumerates each underlying's contracts (`/markets/options/lookup`) and subscribes those. An empty universe is an error, stated as such.
- Streaming handshake: the adapter creates a short-lived session (`POST /v1/markets/events/session`), connects to `wss://ws.tradier.com/v1/markets/events`, and refreshes contracts + session on every reconnect.
- **Timesales carry bid/ask at print time** — that becomes the tick's NBBO, so aggressor calls need no extra lookups.
- Chains come with greeks (ORATS-sourced) for GEX and vol/OI.
- House quirk the adapter absorbs: Tradier collapses single-element collections to a bare object and empty ones to `null` or the string `"null"`; every collection read is normalized.
- Sale conditions: Tradier's timesale `flag` vocabulary is not publicly documented, so the adapter keeps the flag verbatim and normalizes only what it can synthesize with confidence: the `cancel` boolean → `cancel`; `correction` → `late` (the print is real, its timestamp cannot anchor sweeps or sides); pre/post-session prints → `late`. Everything else surfaces as `unknown`, kept but flagged.

## ThetaData

The adapter talks to your **locally running Theta Terminal** (v3) — auth happens at terminal launch, so there is no API-key env var here. Entitlement is tiered: a free end-of-day tier exists; paid tiers add real-time quotes, open interest, and greeks; **streaming requires their standard options tier or higher** — see [ThetaData's site](https://www.thetadata.net/) for current tiers. Where your tier stops, enrichment degrades to nulls and the affected score components say so.

```bash
# only needed when the terminal is not on its default local ports:
export THETADATA_BASE_URL=http://127.0.0.1:25503
export THETADATA_WS_URL=ws://127.0.0.1:25520/v1/events
```

```ts
export default defineConfig({
  feed: { id: "thetadata" },
  universe: { underlyings: ["SPY", "NVDA"] },
});
```

| Config key | Default | Notes |
|---|---|---|
| `feed.thetadata.baseUrl` | `http://127.0.0.1:25503` | Terminal v3 REST (the adapter appends `/v3`) |
| `feed.thetadata.wsUrl` | `ws://127.0.0.1:25520/v1/events` | Terminal v3 event stream |

Specifics and quirks:

- **The Theta Terminal must be running** before `whale run`; the adapter targets Terminal **v3** (the legacy v2 terminal on :25510 is not supported). Env vars relocate a terminal running elsewhere (e.g. Docker).
- The terminal's full-trade stream delivers every OPRA print; the terminal subscribes per-contract or full-universe, nothing in between, so **your underlyings filter is applied client-side** — budget bandwidth for the full stream.
- Interleaved quote events from the terminal are cached per contract and attached as each print's NBBO.
- Tier mapping observed by the adapter: snapshot trades = Standard, quotes/OI = Value, greeks = Professional.

## Alpaca

The zero-dollar live path: free signup gets the **indicative** options feed (derived quotes/trades); their paid market-data subscription (Algo Trader Plus) gets full OPRA — see [Alpaca's data plans](https://alpaca.markets/data).

```bash
export ALPACA_API_KEY_ID=...
export ALPACA_API_SECRET_KEY=...
```

```ts
export default defineConfig({
  feed: { id: "alpaca", alpaca: { stream: "indicative" } },  // or "opra" with the subscription
  universe: { underlyings: ["SPY", "NVDA"] },
});
```

| Config key | Default | Notes |
|---|---|---|
| `feed.alpaca.stream` | `indicative` | `indicative` = free feed; `opra` = paid subscription |

Specifics and quirks:

- The options stream (`wss://stream.data.alpaca.markets/v1beta1/{feed}`) is **msgpack-only**; the adapter ships its own codec.
- Alpaca documents no per-underlying channel wildcards for options, so the adapter subscribes trades on `*` and **filters client-side** by parsed underlying — another full-universe stream to budget for.
- Chain snapshots carry greeks/IV but **no open interest** — `oi` stays null, the `volOi` score component reports itself missing, and GEX from this feed has no OI to weight (use a chain from a feed that provides OI for GEX work).
- NBBO is not attached to stream trades; the runner fetches the latest option quote per print (cached).
- Spot comes from Alpaca's free IEX stock quote.
- Sale conditions arrive as OPRA's single-character codes relayed verbatim; the adapter maps the letters (case-significant) per the OPRA participant spec and Alpaca's own conditions endpoint.

## Massive (formerly Polygon)

Polygon.io rebranded to Massive; same API and keys, new domains (the polygon.io hosts remain live aliases). Entitlement: **delayed options on the entry tier; real-time OPRA with greeks on advanced** — see [Massive's site](https://massive.com/) for current plans.

```bash
export MASSIVE_API_KEY=...        # POLYGON_API_KEY is accepted as a fallback
```

```ts
export default defineConfig({
  feed: { id: "massive", massive: { stream: "realtime" } },  // "delayed" on the entry tier
  universe: { underlyings: ["SPY", "NVDA"] },
});
```

| Config key | Default | Notes |
|---|---|---|
| `feed.massive.stream` | `realtime` | `delayed` selects the 15-minute-delayed WS host (`wss://delayed.massive.com`) |
| `feed.massive.restBase` | `https://api.massive.com` | REST base for snapshots/NBBO |

Specifics and quirks:

- Trades stream over WebSocket with true per-underlying channels (`T.<underlying>`; an empty universe subscribes `T.*`, the whole market — heavy).
- **Match `stream` to your plan**: a delayed-tier key on the real-time host is an auth error, stated as such.
- Chain snapshots carry greeks, IV, OI, and quotes (paginated REST); NBBO for aggressor calls is looked up per print via the single-contract snapshot, which needs a quotes-entitled plan.
- Sale conditions arrive as numeric ids matching the vendor's documented options condition set; ids in the gaps are legacy codes and normalize to `unknown`, kept but flagged.

## synthetic

Zero keys, zero dollars: a seeded generator producing statistically plausible flow with injected motifs — multi-exchange sweeps, blocks, minutes-long ladders, spread legs that must *not* flag, cancels — over GBM underlyings with a vol smile. Same seed ⇒ same tape, byte for byte; it is both the demo and the test substrate. Recorded real OPRA data cannot be redistributed, so every sample in this repository is synthetic.

| Config key | Default | Notes |
|---|---|---|
| `feed.synthetic.seed` | 42 | the tape is a pure function of this |
| `feed.synthetic.regime` | `mixed` | `mixed` \| `quiet` \| `sweep-clusters` \| `earnings-ramp` |
| `feed.synthetic.eventsPerMinute` | 120 | background print intensity |

CLI shortcuts: `--feed synthetic --seed 7 --regime sweep-clusters`.

## replay

Re-run your own recorded tapes (`whale run --record tape.ndjson`) as a feed: `feed.tapePath` points at the NDJSON file, or use `whale replay --file` directly. Tape rows are fully enriched ticks, so replay needs no lookups and no credentials — see [replay.md](replay.md).

## Historical backfill

`whale backfill` warms baselines from a vendor's historical surface so the first live session scores against real history instead of flagging everything cold-start (the walkthrough is in the [README](../README.md#warm-start)):

```bash
whale backfill --feed synthetic --sessions 5 --tickers NVDA,SPY   # zero-key demo
whale backfill --feed thetadata --sessions 20                      # or --dates 2026-08-01..2026-08-21
```

`--sessions N` walks back N weekdays from today (no exchange-holiday calendar — a holiday in the window is an empty session, skipped gracefully); `--dates` targets an explicit ISO range. Re-running a window is idempotent (overwrite-safe upserts), one vendor failure degrades one date × underlying rather than the run, and a date interrupted mid-stream is never folded — a truncated day written as a baseline would bias every score against it.

Backfill needs two optional adapter methods, and coverage is per vendor:

| Feed | Historical trades (`getHistoricalOptionTrades`) | As-of-date chain (`getHistoricalChain`) |
|---|---|---|
| `synthetic` | **yes** — (seed, date) fully determine a past session, so backfill is reproducible and zero-key: this is the demo path | **yes** — EOD snapshot of the generated chain, folded into OI/IV daily history |
| `thetadata` | **yes** — v3 history endpoints through the local terminal; historical trades need a Standard+ subscription | **yes** — EOD report + as-of-date open interest; greeks history is not fetched (its v3 path is unverified, so it is not guessed at), and spot close degrades to null without a stock entitlement |
| `massive` | **yes, with a cost cap** — there is no trades-by-underlying historical endpoint, only per-OCC-contract trades, so the adapter enumerates the chain's contracts as of the date and iterates them. A liquid underlying lists thousands of contracts, i.e. **thousands of REST calls per session**; hard caps (2,500 contracts per date × underlying, 10 pages per contract) bound the worst case | **no** — the snapshot endpoint is current-state only and no documented endpoint returns OI as of a past date, so the adapter returns null rather than fabricating history. OI/IV daily history accrues from live sessions instead |
| `alpaca` | **yes** — historical option trades per contract symbol, enumerated from the snapshots endpoint. The data API has no as-of-date contract listing, so contracts already expired by the time backfill runs cannot be recovered: a recent window is mostly intact, older sessions thin out | **no** — Alpaca's snapshots carry no open interest and there is no historical chain endpoint; volume baselines still warm from trades, OI-dependent context accrues live |
| `tradier` | **no — deliberately.** Tradier documents daily OHLC bars and equity-only intraday timesales; no per-print historical option trades exist. Baselines synthesized from daily bars would not be the per-print distributions the engine scores against, so the adapter leaves the method undefined and `whale backfill --feed tradier` says so and points at the feeds that do support history | **no** — same reasoning; baselines accumulate from live `whale run` sessions |

Where a vendor offers as-of-date chains, backfill also folds them into the daily OI/IV history that powers `whale market` and the cross-session `whale audit` horizons. Backfill deliberately does **not** run the engine — no events, no alerts, no raw ticks; it rebuilds exactly the end-of-session state (via the same intraday accumulation and condition policy the engine uses) that finished live sessions would have left behind.

## The FeedAdapter contract (for contributors)

An adapter is one class implementing `FeedAdapter` ([`packages/core/src/feeds/types.ts`](../packages/core/src/feeds/types.ts)) plus a registration. The engine never sees vendor shapes — the adapter's whole job is honest translation.

```ts
interface FeedAdapter {
  readonly id: FeedId;
  capabilities(): FeedCapabilities;             // realtime? greeks? NBBO with trades? conditions?
  subscribeOptionTrades(filter, signal?): AsyncIterable<RawOptionTrade>;
  getNbbo(contract): Promise<Nbbo | null>;      // latest quote, for prints without one attached
  getChainSnapshot(underlying): Promise<ChainSnapshot | null>;  // strikes, OI, greeks/IV when provided
  getSpot?(underlying): Promise<number | null>; // best-effort; null when the vendor has no equity data
  normalizeCondition(code): NormalizedCondition;
  getHistoricalOptionTrades?(underlying, dateIso, signal?): AsyncIterable<RawOptionTrade>;  // powers `whale backfill`
  getHistoricalChain?(underlying, dateIso): Promise<ChainSnapshot | null>;  // as-of-date OI/IV for daily history
  close?(): Promise<void>;
}
```

What earns trust, in order:

1. **Stream `RawOptionTrade`s with vendor condition codes verbatim** — normalization happens exactly once, through your condition table. `contract` must be OCC/OSI-parsable.
2. **The condition-mapping duty.** Ship a complete table mapping the vendor's sale-condition codes onto the normalized vocabulary in [`conditions.ts`](../packages/core/src/conditions.ts) — this is what decides whether a print can score, sweep, or block ([classification.md](classification.md)). Every mapping must **cite its source** (vendor docs, official SDK enums, the OPRA participant spec) in a comment, the way the existing four adapters do. Unmapped codes must fall through to `"unknown"` — the engine keeps them and flags the events, because silently dropping unknowns would bias the tape.
3. **Attach whatever enrichment the vendor already sends** (NBBO alongside trades, greeks on chains) so the runner skips lookups; implement the lookup methods for the rest. Fields the vendor cannot provide stay `null` — never fabricated.
4. **Register it** in [`feeds/registry.ts`](../packages/core/src/feeds/registry.ts) via `registerFeed(id, factory)`, reading credentials from vendor-named env vars in the factory.
5. **Add a canary** (below) and unit tests against recorded-shaped fixtures you invent (never real market data — see [CONTRIBUTING.md](../CONTRIBUTING.md)).

Architecture context — where adapters sit in the dataflow and why the engine does no I/O: [architecture.md](architecture.md).

## Canaries

Vendor APIs drift. Each adapter has a canary script — [`scripts/canaries/`](../scripts/canaries) — that CI runs daily against the vendor's sandbox or free tier, and the README carries a badge per feed.

The output contract, identical across canaries:

- One line starting with `PASS`, `SKIP`, or `FAIL`.
- **SKIP** (exit 0): credentials are absent, or the local dependency is unreachable (ThetaData's canary skips when no terminal is running). A lane without secrets stays green rather than lying red.
- **PASS** (exit 0): the adapter still speaks the vendor's dialect — auth works, live response shapes map, the condition table covers what the vendor sends. Alpaca's canary goes further: it fetches the vendor's own conditions list and fails on any letter the table does not cover — the drift alarm.
- **FAIL** (exit 1): an adapter defect or vendor drift, with the reason on the line.

Run them locally:

```bash
TRADIER_ACCESS_TOKEN=... pnpm canary:tradier
MASSIVE_API_KEY=...      pnpm canary:massive
ALPACA_API_KEY_ID=... ALPACA_API_SECRET_KEY=... pnpm canary:alpaca
pnpm canary:thetadata    # needs a local Theta Terminal; SKIPs otherwise
```

Canaries exercise the cheapest real surface (REST snapshots, condition tables, one stream handshake where the free tier allows) and treat entitlement gaps as SKIP-shaped conditions, not failures — a red canary means the *adapter* is wrong, which is exactly what a badge should mean.
