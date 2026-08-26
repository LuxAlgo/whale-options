# Context: FINRA daily short-sale volume

Whale Options deliberately ships **no real-time dark-pool prints** — real-time off-exchange data requires licensing that does not self-serve, and a tool implying otherwise is showing you something else (see "What it deliberately does not do" in the [README](../README.md)). The honest substitute is this module: FINRA's **daily short-sale volume files** — free, public, end-of-day — cached in your own flight recorder.

All sample data in this document is invented.

## What the data is

FINRA publishes a daily file of short-sale volume for **off-exchange trades reported to FINRA facilities** — the consolidated (CNMS) file, one pipe-delimited row per symbol:

```text
Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market
20260824|NVDA|1200000|4000|3000000|B,Q,N
```

- `ShortVolume` — shares that printed as short sales that session.
- `TotalVolume` — that symbol's total off-exchange volume reported to FINRA that session (not the consolidated-tape total).
- The **short ratio** this module reports is `ShortVolume / TotalVolume` per session.

Files live at a fixed URL per date (`.../CNMSshvol<YYYYMMDD>.txt`) and appear after the close. Weekends and market holidays have no file; the sync treats a missing file as a skip, not an error.

## What the data is not

Every report from this module carries this note, and it is the substance, not a disclaimer:

> FINRA consolidated short-sale volume: off-exchange trades reported to FINRA facilities, published end-of-day. A high short ratio is NOT a real-time dark-pool signal, and short volume is NOT short interest — market-maker hedging and liquidity provision print short structurally, so elevated ratios are the mechanical norm, not evidence of directional bets. End-of-day context only.

Unpacked:

- **Short volume ≠ short interest.** Short interest is an outstanding-position count reported twice a month; this is one day's flow. A market maker who shorts into a buy order and covers minutes later adds to short volume and to nobody's short position.
- **End-of-day only.** The file for a session exists only after that session. Nothing here updates intraday, and nothing here should be framed as if it did.
- **Off-exchange ≠ "dark pool intel."** The file aggregates trades reported to FINRA facilities — wholesalers, ATSs, everything off-exchange — without venue-level attribution of intent. It says how much off-exchange volume printed short; it does not say who was doing what, or why.
- **Structurally high baseline.** Because liquidity providers print short mechanically, ratios around half of a symbol's off-exchange volume are normal. Compare a symbol against its *own* recent history, never against a fixed threshold.

## Commands

```bash
# read the cached history (no network)
whale context short-volume NVDA --days 20

# fetch missing days from FINRA first, then report
whale context short-volume NVDA --days 20 --sync

# machine-readable
whale context short-volume NVDA --json
```

Output is a per-session table — date, short volume, total off-exchange volume, ratio with a bar — followed by the average ratio and, every time, the note above. Without `--sync` the command reads the cache only, and hints at `--sync` when the cache is empty.

`--sync` walks back N weekdays, skips dates already fully cached, downloads each missing day's file from FINRA, and stores it. One file covers the whole market, so the sync filters to **your configured universe** (`universe.underlyings` plus the requested symbol) before storing — the flight recorder keeps only the symbols you actually track.

The MCP tool `whale_short_volume` serves the same report to agents from the same cache. It is **cache-read only** — the MCP server never touches the network; syncing is the CLI's job.

## Caching model

- Rows live in the flight recorder (`short_volume_daily`), keyed by symbol + session date; re-syncs are idempotent upserts.
- Your installation fetches from FINRA's public URLs directly — no key, no intermediary, and nothing redistributed by this project. The data stays on your machine, like everything else in the flight recorder.
- A date is re-fetched only when some requested symbol has no cached row for it (so adding a symbol to your universe backfills it on the next sync).
- Holidays are not modeled: a date with no file 404s, is reported in `daysSkipped`, and is retried on the next sync — which stays cheap because every cached date is skipped without a request.

## API

From `@luxalgo/whale-core`:

- `parseShortVolumeFile(text, source)` — pure parser; header-tolerant, skips malformed lines and the trailing record-count line.
- `fetchShortVolumeDay(dateIso, {baseUrl?, fetchImpl?})` — download + parse one day; throws `ShortVolumeFileMissingError` when FINRA has no file for the date.
- `syncShortVolume({store, symbols, days, today?, fetchImpl?, baseUrl?})` — the weekday walk-back described above; returns `{daysFetched, daysSkipped, rowsStored}`.
- `shortVolumeReport(store, symbol, days?)` — cached history with per-day ratios, the average, and the note. Always the note.
