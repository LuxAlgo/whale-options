# `whale audit` — score calibration

Flow tools like to market outcome numbers nobody can check. This project ships the opposite: a measuring instrument you run against your **own** flight recorder, skeptical by default. `whale audit` asks one narrow question — *on the tape I recorded, did higher-scored events precede underlying moves in their direction more often than the base rate?* — and reports the answer with its exclusions, its noise flags, and its caveats attached. It makes no claims. We haven't measured your tape; only you can.

```
whale audit [--horizon 1h] [--from <ts> --to <ts>] [--underlying NVDA] [--exclude-cold-start] [--json]
```

Defaults: the full recorded range, horizon `1h`. The MCP server exposes the same computation as the `whale_audit` tool. The implementation is [`packages/core/src/audit/calibration.ts`](../packages/core/src/audit/calibration.ts) — pure computation over the store, deterministic given the store contents.

## What it measures

For every recorded event in the window with a directional side (`buy` or `sell`) and a spot observation at event time:

- **Forward return of the UNDERLYING** over the chosen horizon:

  ```
  fwdReturnPct = (forwardSpot − eventSpot) / eventSpot × 100
  ```

  `eventSpot` is the spot stored on the event at classification time.

- **Alignment**: did the underlying move the event's way — `buy` → up, `sell` → down? An exact-zero move counts as **not** aligned; the tape gets no benefit of the doubt. Events with side `mid` or `unknown` have no direction to be aligned with: they are excluded from everything, counted, and reported in `excluded`.

It never measures option P&L. See the caveats.

## Forward-price sources, per horizon

Documented here and restated in every report's caveats — you always know which source produced the numbers.

| Horizon | Source |
|---|---|
| `15m`, `1h` | The store's own ticks carry a spot observation per print. The forward price is the spot on the **first** tick of the underlying at `ts ≥ event.ts + horizon`, accepted only within a **20-minute tolerance** — a quiet or truncated tape yields `noPriceData`, never an interpolation. |
| `eod` | `underlying_daily.spotClose` for the event's own session date; when that row is absent (fresh install, no end-of-session fold yet), the last recorded spot observation of that session at or after the event. |
| `1d`, `5d` | `underlying_daily.spotClose` of the 1st/5th **recorded** session date after the event's session. "Recorded" is deliberate: sessions your recorder never saw don't exist here, and missing history yields `noPriceData`, not a guess. |

Implementation notes: events are swept in one pass per underlying, streaming that underlying's ticks once for the whole horizon (spot observations only — two numbers per tick — sorted once, binary-searched per event), so memory stays bounded on large windows.

## The report

```ts
{ window: {from, to}, horizon,
  eventsConsidered, eventsWithOutcome,
  excluded: { mid, unknown, noPriceData },
  buckets:  [{ label, n, medianFwdReturnPct, meanFwdReturnPct, alignedPct, smallN }],
  byKind:   same shape (sweep/block/split/print),
  bySide:   same shape (buy/sell),
  baseRate: { alignedPct, medianFwdReturnPct },
  caveats:  string[]   // always populated
}
```

- **Buckets are fixed 10-point score bins** — `0–10` … `90–100`, empty bins dropped. Fixed bins rather than deciles of the observed score distribution: simpler to read, and stable across runs and windows, so two reports are comparable. Bin membership is `min(9, floor(score / 10))`.
- The bucket `n`s always sum to `eventsWithOutcome`, in the main table and in both cuts — the accounting reconciles or the report is a bug.
- `smallN` flags any bucket with `n < 30`.
- `baseRate` is computed over **all** events with an outcome in the same window — the honest comparator alongside the 50% coin flip.

## How to read a calibration table

```
by score bucket
bucket        n   median fwd    mean fwd   aligned   vs base
0–10        412       +0.011%     +0.008%     50.2%    -1.1pt
...
70–80        86       +0.084%     +0.102%     58.1%    +6.8pt
90–100        7       +0.310%     +0.295%     71.4%   +20.1pt  (n<30 — noise)
```

- **Compare `aligned` to the base rate first, the coin flip second.** A tape recorded during a steady drift will show every bucket "aligned" above 50% on the buy side — that is the drift, not the score. The `vs base` column exists so the drift can't masquerade as calibration.
- **A calibrated score slopes.** If higher buckets don't beat lower buckets against the same base rate, the score is not discriminating on your tape at that horizon — that is a finding, and a useful one.
- **Dim rows are noise.** `n<30` rows are printed dimmed and flagged; quoting one as a result is exactly the move this tool exists to discourage.
- **Cuts before conclusions.** `byKind` and `bySide` show whether an apparent slope lives in one kind of event or one side of the tape.

## Caveats — the full list

Every report carries these; the CLI prints them every time, no flag hides them.

1. **Forward-price source** for the chosen horizon, stated exactly (table above). Gaps in your recording are gaps in the report.
2. **Selection effects.** The measurement covers only what your recorder captured: the windows the engine ran, the universe you subscribed, the events your config emitted. It says nothing about any other tape.
3. **No option P&L, no costs.** Returns are underlying moves. Transaction costs, spreads, slippage, and exercise mechanics are not modeled; an aligned underlying move does not imply the option made money. This is also why no option "win rate" is computed: option P&L is path-dependent and spread-dependent, and a number we couldn't defend would be worse than none.
4. **Small buckets are noise.** `n < 30` is flagged inline.
5. **Alignment conventions.** Zero moves count against; mid/unknown sides are excluded and counted; compare to the base rate, not just 50%.
6. **Correlation is not causation.** A calibration table is a measurement of one recorded window — not a forecast, not trading advice.
7. **Synthetic tape** (when detected via the events' `feedId`): outcomes are meaningless by construction; the run demonstrates the instrument only.

## Philosophy

This is a measuring instrument, not a performance claim. The incumbents publish outcome statistics that cannot be independently reproduced; we publish the ruler instead. Run it on your own recorder, over your own windows, with your own config — the report is deterministic, so anyone with the same store gets the same numbers. We make no claims about what it will show, and we publish nothing we haven't: the only calibration tables this project ships come from the seeded synthetic tape, labeled as such, where the outcomes are meaningless by construction and only the instrument is on display.
