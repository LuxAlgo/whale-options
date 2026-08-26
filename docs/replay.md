# Flight recorder & replay

The flight recorder exists so that no classification is ever an unverifiable claim. Everything the engine emitted can be re-run, re-judged under different settings, and diffed — deterministically.

All command output in this document is captured from the seeded synthetic feed.

## The tick is the unit of record

`OptionTradeTick` is **self-contained**: the NBBO used for the aggressor call, the underlying spot, and the contract's open interest ride on the tick itself, attached exactly once at ingest by the runner. The engine performs zero I/O and zero lookups. Consequences:

- a recorded tape replays with no external state and no credentials,
- every side call can be audited against the exact quote it was judged with, forever,
- and the determinism contract holds: **same tape + same config ⇒ byte-identical event stream, ids included** (event ids are content hashes; nothing in the engine consults a wall clock or a random source — see [architecture.md](architecture.md)).

Demonstrated, not asserted — two replays of the same recorded tape, hashed:

```text
$ whale replay --file tape.ndjson --ndjson | sha256sum
d7a48ad53b358b273bc1441740d02a47238466d8838cfb72610d3b13e9d51396  -
$ whale replay --file tape.ndjson --ndjson | sha256sum
d7a48ad53b358b273bc1441740d02a47238466d8838cfb72610d3b13e9d51396  -
```

## Recording

Two recordings happen, one always and one on request:

- **The flight recorder (always, live runs):** `whale run` stores every normalized tick and every emitted event in SQLite (default `.whale/whale.db`, WAL mode — single writer, concurrent readers for the dashboard/MCP/CLI). `--db :memory:` opts out of persistence entirely.
- **Tape files (on request):** `whale run --record tape.ndjson` additionally appends every tick to an NDJSON file — one JSON tick per line, fully enriched. Tapes are portable, diffable, git-committable (the repo's golden fixtures are exactly this), and preserve original sequence numbers so event ids survive replay even for a window cut from a longer recording.

## Replaying

```text
Usage: whale replay [options]

re-run a tape file or a flight-recorder window through the current config

Options:
  --config <path>      config file (default: whale.config.* in cwd)
  --file <tape>        NDJSON tape file (from --record); otherwise reads the store
  --from <ts>          window start (ISO datetime or epoch ms)
  --to <ts>            window end (ISO datetime or epoch ms)
  --underlying <sym>   restrict to one underlying
  --db <path>          flight recorder path
  --min-premium <usd>  emission floor in premium dollars
  --diff               compare replayed events against what the store recorded
  --ndjson             emit events as NDJSON
  --verbose            print reasons and score breakdowns
  --quiet              only print the summary
```

Two modes:

- **File replay** — `whale replay --file tape.ndjson`. Runs the tape through a fresh engine with empty baselines and a scratch in-memory store. No flight recorder needed; nothing is persisted.
- **Store-window replay** — `whale replay --from <ts> --to <ts>` (both required without `--file`). Streams the stored ticks of that window through a fresh engine under the **current** config. Baselines are hydrated from stored sessions *before* the window's first session date — the same prior-day context a live engine would have had going into that window.

Replay **never writes events and never fires alerts**, in every mode. It is a lens, not a second recorder. (The MCP tool `whale_replay` is the same operation over the same store, capped at 7-day windows — [mcp.md](mcp.md).)

## `--diff`: what would today's config have flagged?

Because the engine is deterministic, replaying a window under the recording config reproduces the recording exactly — so any difference under a *changed* config is attributable to the change, event by event. `--diff` matches replayed events against stored ones by id and reports three lists: `added` (current config would emit; the live run didn't), `removed` (recorded live; gone now), `score_changed` (same event, different judgment).

Captured sequence — first the identity check, then after editing the config (aggression weight 0.2 → 0.35, urgency 0.1 → 0.05, premium floor $10K → $25K):

```text
$ whale replay --db .whale/whale.db --from 2026-08-24T13:30:00Z --to 2026-08-24T20:00:00Z --diff --quiet
replayed 94 stored ticks
diff vs store: 0 added, 0 removed, 0 score-changed (of 33 stored)

$ whale replay --config whale.config.json --db .whale/whale.db --from 2026-08-24T13:30:00Z --to 2026-08-24T20:00:00Z --diff --quiet
replayed 94 stored ticks
diff vs store: 0 added, 13 removed, 20 score-changed (of 33 stored)
  - print SPY260828P00700000 score 43.5
  - block AMD260828P00155000 score 52.2
  - print NVDA260828C00190000 score 43.8
  ~ SPY260918C00605000 24.1 → 35.4
  ~ NVDA260911C00182500 29.7 → 40
```

The 13 removals are the raised premium floor doing exactly what it says; the 20 score changes are the reweighting, each shown as before → after. This is the workflow for tuning: change weights or thresholds, replay yesterday, read precisely what would have been flagged differently — before running the new config live.

## Caveats, stated plainly

- **Live vs replay (inherent, documented):** a live feed that delivers prints far out of time order can resolve a sweep window before a late leg arrives; replaying the recorded tape — where arrival order is the recorded order — is the authoritative classification. Replay of a given tape is always self-consistent.
- **`--underlying` restricts the tape, and the tape is the context.** Block thresholds, premium percentiles, and repetition are derived from the tape being replayed; replaying one symbol re-derives them from a one-symbol tape. The diff can then reflect *context*, not config. The authoritative diff replays the full window unrestricted.
- **Stored events reflect the process that emitted them.** Intraday context (day volumes, histograms, repetition) lives in the engine's memory during a live run. If a store window spans several separate live runs, each run only had its own context, while replay re-derives context from the window's full tick sequence — the replayed result is the self-consistent one. For clean diffs, compare within windows recorded by one continuous run.

## Retention

The flight recorder prunes at the end of each live run:

| Key | Default | Meaning |
|---|---|---|
| `store.driver` | `sqlite` | `sqlite` or `memory` |
| `store.path` | `.whale/whale.db` | `:memory:` disables persistence |
| `store.ticksRetentionDays` | 7 | raw ticks older than this are deleted |
| `store.eventsRetentionDays` | 90 | events older than this are deleted |

Ticks are the heavy table and the replayable substrate: a window is replayable only while its ticks are retained. Keep tapes (`--record`) of anything you want to replay beyond the tick retention horizon — tapes are yours, flat files, no expiry. Baselines, rules, and the alert audit trail are small and are not pruned.

## Daily history feeds the analytics

Alongside baselines, each session folds a daily-history layer into the store — per-contract OI/volume/IV rows and per-underlying spot-close/ATM-IV rows, written at end of session by live runs and by [`whale backfill`](feeds.md#historical-backfill). These tables are not replay inputs; they are what the analytics read: `whale market` computes OI deltas, max pain, and IV rank from them ([README](../README.md#market-structure)), and `whale audit` takes its cross-session forward prices (`eod`/`1d`/`5d` horizons) from the recorded closes ([audit.md](audit.md)). Like everything else here, they only contain sessions your recorder actually saw.

## Sizing: `whale bench`

`whale bench` measures engine throughput and store growth on a synthetic tape, so retention can be sized with numbers instead of vibes (CI also uses it as a regression gate via `--min-ticks-per-sec`). Captured on the container this documentation was written on:

```text
$ whale bench --events 10000
whale bench
  tape            10,000 ticks → 8,871 events
  engine          249ms  (40,105 ticks/sec)
  push latency    p50 0.013ms · p99 0.118ms · max 11.823ms
  store writes    311ms  (32,165 ticks/sec, batched)
  growth          ~305MB per million ticks (size retention accordingly)
```

(The bench config sets the premium floor to zero so every classified event is emitted and counted — hence the high event count.) Numbers vary with hardware; the growth estimate is the one to plan around: at roughly 305 MB per million ticks, a universe printing 500K ticks/day costs about 150 MB/day of tick storage times `ticksRetentionDays`.
