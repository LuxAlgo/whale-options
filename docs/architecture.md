# Architecture

Whale Options is built around one principle: **the engine is a pure function of the tape.** Everything else follows from it — deterministic replay, golden tests, and a flight recorder whose stories can be re-run and audited.

## Dataflow

```
feed adapter (vendor I/O)          @luxalgo/whale-core
┌─────────────────────┐   raw    ┌──────────────────────────────────────────┐
│ thetadata │ massive │  prints  │ normalize (OCC parse, condition mapping) │
│ alpaca    │ tradier ├─────────▶│ enrich (NBBO @ print, spot, OI)          │
│ synthetic │ replay  │          │        = self-contained OptionTradeTick  │
└─────────────────────┘          │            │                             │
                                 │            ▼                             │
                                 │ ENGINE (pure, event-time only)           │
                                 │  ├─ aggressor: price vs NBBO             │
                                 │  ├─ sweep windows (rolling, per side)    │
                                 │  ├─ block thresholds (bucket percentile) │
                                 │  ├─ split/ladder (minutes-scale)         │
                                 │  ├─ cancels (void in-window legs)        │
                                 │  └─ whale score (6 components, baselines)│
                                 │            │ FlowEvent                   │
                                 └────────────┼─────────────────────────────┘
                                              ▼
                    ┌──────────────┬──────────────────┬──────────────┐
                    │ flight       │ alert dispatcher │ live WS      │
                    │ recorder     │ (rules → sinks)  │ (dashboard,  │
                    │ (SQLite)     │                  │  MCP, CLI)   │
                    └──────────────┴──────────────────┴──────────────┘
```

The analytics modules (`backfill/`, `audit/`, `market/`, `context/`, `compare/`) sit entirely on the flight-recorder side of this diagram: they read (and, for backfill and context, write) the store's baseline, daily-history, and event tables, and never touch the pure engine — the engine stays a function of the tape, and everything downstream is arithmetic over what it recorded.

## The tick is the unit of record

`OptionTradeTick` is **self-contained**: the NBBO used for aggressor inference, the underlying spot, and the contract's open interest ride on the tick itself, attached once at ingest by the runner. The engine performs **zero I/O and zero lookups** — which means:

- a recorded tape replays with no external state (`whale replay --file tape.ndjson`),
- the flight-recorder window replays against the exact NBBO each print was judged with,
- goldens are byte-stable.

## Determinism contract

**Same tape + same config ⇒ byte-identical event stream, ids included.**

What this requires, and where it lives:

| Requirement | Where |
|---|---|
| No wall clock in classification | engine windows are event-time (`tick.ts`) only; the runner's idle flusher only forces window *resolution*, never changes membership on a replayed tape |
| No randomness | event ids are content hashes (`sha256` of legs + first seq); the synthetic feed is seeded |
| No environment dependence | US/Eastern session math is computed from DST rules directly, no `Intl`/ICU |
| Stable ordering | ticks carry a monotonic `seq`; window resolution sorts by (deadline, first seq) |
| Stable numbers | event fields round at fixed precision |

Live vs replay caveat (documented, inherent): a live feed that delivers prints far out of time-order can resolve a window before a late leg arrives; replaying the recorded tape is the authoritative classification. Replay of a given tape is always self-consistent.

## Module map (`packages/core/src`)

| Module | Responsibility |
|---|---|
| `types.ts` | Canonical domain types (`OptionTradeTick`, `FlowEvent`, `WhaleScore`, …) |
| `config.ts` | Zod schema; every threshold and weight, defaulted and documented |
| `occ.ts` | OCC/OSI symbology (parses vendor variants, emits canonical) |
| `conditions.ts` | Normalized sale-condition vocabulary + the policy table (score/sweep/block/volume eligibility per condition) |
| `feeds/` | `FeedAdapter` interface, registry, synthetic generator, tape replay/writer |
| `normalize/` | Raw vendor print → canonical tick (exactly once) |
| `classify/` | Aggressor inference; sweep/block/ladder state machine; cancel handling |
| `score/` | Rolling baselines (20-session volume, premium and size histograms) + the six-component whale score |
| `greeks/` | Black-Scholes (with dividend yield), Brent IV solve, GEX ladder + zero-gamma scan |
| `alerts/` | Rule matching, sinks (stdout/webhook/discord/telegram/desktop), queued dispatcher with retries |
| `store/` | `FlightRecorder` interface; SQLite (default) and in-memory implementations |
| `backfill/` | Historical ingestion: replays a vendor's past sessions through the same normalize/accumulate path to warm baselines and daily OI/IV history — no events, no alerts |
| `audit/` | Score calibration vs forward underlying moves, computed over the store — caveats are part of the report |
| `market/` | Market-structure analytics over the daily-history tables: OI deltas, max pain, IV rank, net flow — each result carries its honesty note |
| `context/` | FINRA daily short-sale volume: sync into the local cache, report with the standing EOD-context note |
| `compare/` | Feed cross-validation: two feeds, same window, diff the tapes (missing prints, condition disagreements, timestamp skew) |
| `engine.ts` | The pure state machine: `push(tick) → FlowEvent[]`, `flush()`, session rollover |
| `runner.ts` | The async world: feed → normalize → enrich → engine → store/alerts/live |
| `server/` | Local HTTP + WS API for the dashboard and LAN readers (binds 127.0.0.1) |

## Classification semantics (summary)

- **Aggressor**: at/above ask ⇒ buy, at/below bid ⇒ sell, between ⇒ mid; no NBBO, stale NBBO (> `nbboStaleMs`), or a condition that voids the timestamp ⇒ **unknown — never guessed**. The NBBO used is stored on the tick.
- **Sweep**: same contract, same side, ≥2 prints across ≥2 exchanges inside a rolling window (default 500 ms). Legs are *held* until the window resolves, so a print is never counted both as a leg and as a standalone event. ISO conditions corroborate (reasons + aggression bonus).
- **Block**: single print ≥ max(bucket floor, p99.5 of the liquidity bucket's trade-size distribution). Buckets come from the contract's own 20-session average volume — fixed thresholds are how flow tools flag noise on illiquid names.
- **Split/ladder**: ≥4 same-contract same-side clips inside 10 minutes, spread over more than a few sweep-windows of time. The split event references clips that already printed (its legs overlap prints by design; premium-conservation checks therefore run over sweep/block/print only).
- **Conditions**: spread legs count volume but never score (the classic false-positive source); cancels void a matching leg still inside an open window and decrement day volume; late/out-of-sequence prints can still be blocks but never join sweeps and never get a side.
- **Cold start**: scores flag `coldStart` until a contract has `minBaselineDays` of history; missing inputs null their component and the remaining weights renormalize — the score never pretends it knew something it didn't.

Full details with formulas: `docs/scoring.md` and `docs/classification.md`.

## Storage

SQLite in WAL mode (single writer — the engine; concurrent readers — dashboard/MCP/CLI). Hot columns are real columns; full payloads are JSON. Tables: `ticks_raw` (ring buffer, retention-pruned), `events`, `baseline_*` (per session date), `chain_snapshots`, `rules`, `alerts_fired`, `meta` (heartbeat, engine stats, schema version).

## Adding a feed adapter

1. Implement `FeedAdapter` (`feeds/types.ts`): stream `RawOptionTrade`s (vendor condition codes verbatim), provide `getNbbo`/`getChainSnapshot`/`getSpot?`, and — the part that earns trust — a complete `normalizeCondition` table mapping the vendor's sale-condition codes onto the normalized vocabulary in `conditions.ts`.
2. Register it in `feeds/registry.ts` via `registerFeed(id, factory)` and add its config/env-var conventions.
3. Attach whatever enrichment the vendor already sends (NBBO alongside trades, greeks on chains) so the runner skips lookups.
4. Add a canary smoke script (connect + parse + condition-map against the vendor's sandbox/free tier) — CI runs these daily and the README carries per-feed health badges.

Credentials are env vars only, named after the vendor (e.g. `TRADIER_ACCESS_TOKEN`), shared with other tools that use the same vendor rather than invented per-project.

## Package graph

```
whale-core  ←  whale-cli   (commander UI, config loading)
           ←  whale-mcp    (MCP stdio server)
           ←  whale-dashboard  (via the HTTP/WS API, not imports)
```

`whale-core` never imports from the packages above it. Inside core, `engine.ts` never imports `feeds/`, `store/`, or `server/` — the pure/impure boundary is a module boundary.
