# Feed cross-validation (`whale compare`)

Market-data vendors sell completeness, but hand you no way to check it. `whale compare` is that instrument: subscribe two feeds to the same underlyings for the same window, then diff the tapes —

- **missed prints** — trades one feed delivered and the other did not,
- **condition disagreements** — the same print carrying different sale-condition codes on each feed (conditions decide whether a print may score, join a sweep, or count volume, so vendors disagreeing here changes classifications),
- **timestamp skew** — how far apart the two feeds stamp the same print.

All example output in this document is invented/synthetic — no real vendor data appears here.

## Honest framing, first

The report's `notes` block prints every time, because the numbers are easy to over-read:

- The comparison covers **only the subscribed underlyings over one window**. It says nothing about coverage outside them.
- Venue and SIP reporting paths differ between vendors — **small timestamp skew on matched prints is normal**, not a defect.
- Prints present on one feed and absent on the other are **evidence to investigate with the vendor** (entitlements, condition filtering, connection health, subscription tier), **not proof of a bad feed**. A diff is a question to ask, never an accusation.

## Running it

```text
whale compare --feeds thetadata,tradier --tickers NVDA,SPY --duration 300
whale compare --feeds massive,alpaca --tickers TSLA --duration 60 --tolerance 500 --json
```

| Flag | Meaning | Default |
|---|---|---|
| `--feeds <a,b>` | exactly two feed ids, resolved via the registry (same config, per-vendor env credentials) | required |
| `--tickers <list>` | underlyings both feeds subscribe — the universes must align for the diff to mean anything | required unless a synthetic feed is involved (then the synthetic default universe applies) |
| `--duration <sec>` | collection window (wall clock) | 60 |
| `--tolerance <ms>` | max timestamp gap for two prints to count as the same print | 1000 |
| `--seed-b <n>` | demo only: seed for a second synthetic instance | — |
| `--json` | emit the full `CompareReport` | pretty report |

Both streams are collected concurrently until the duration elapses (or Ctrl-C aborts, diffing whatever was collected). Replayed streams that end before the duration are handled gracefully — collection stops when both streams end.

## The matching algorithm

Deterministic given the same input streams:

1. Each side's raw prints are normalized in arrival order through **that adapter's own condition table** (the same path `whale run` takes; the collection loop never reorders).
2. Ticks are bucketed by the exact key **(contract, price, size)** — a print can only match a print of the same contract at the same price and size. Timestamps are deliberately *not* part of the key, because timestamps are where vendors legitimately differ.
3. Inside each bucket, every (a, b) pair with **|tsA − tsB| ≤ tolerance** is a candidate. Candidates are taken greedily **nearest-timestamp first** (ties broken by a.ts, then b.ts, then arrival order); each tick matches at most once.
4. Everything left unmatched is unique to its side.

Two identical streams therefore match 100% both ways with zero skew — the identity test in `packages/core/test/compare.test.ts` proves it by replaying the same tape through two `ReplayFeed` instances.

### Choosing a tolerance

1000 ms (the default) absorbs normal SIP/venue reporting differences. Tighten it (200–500 ms) when both vendors claim direct OPRA timestamps; loosen it if one feed is delayed. A print that fails to match at 1000 ms but would at 5000 ms is itself a finding — rerun with both tolerances and compare.

## Reading the report

- **`matchedPct.ofA` / `.ofB`** — matched prints as a share of each side's own tape. Read both: 95%/60% means feed B carries many prints A never showed (or B double-reports).
- **`tsSkewMs`** — `b.ts − a.ts` over matched pairs (median/p95/min/max). A stable median is a clock/reporting-path offset; a wide p95–max spread means one feed delivers late bursts.
- **`conditionDisagreements`** (capped at 50) — matched prints whose normalized condition sets differ, order-insensitively. This is the subtle one: a feed that reports a spread leg as `regular` will make flow tools flag prints the other feed correctly ignores.
- **`nbboCoverage`** — the fraction of each side's ticks that carried a quote. Without an NBBO the engine never guesses a side, so low coverage silently degrades aggressor inference.
- **`samples.onlyA` / `.onlyB`** (capped at 20 each) — concrete missing prints (contract, ts, price, size, exchange) to paste into a vendor support ticket. Counts (`onlyA`/`onlyB`) stay exact past the cap.

## The synthetic demo (zero keys)

```text
whale compare --feeds synthetic,synthetic --seed-b 99 --tickers NVDA --duration 10
```

This runs two synthetic instances with **different seeds**. Two seeds generate two different tapes *by construction*, so the report shows massive divergence — intentionally. It proves the instrument detects missing prints end-to-end; it is not a simulation of how two real vendors compare (real feeds observing the same market should mostly agree). The report tags this mode with a loud `SYNTHETIC DEMO` note.

Normally the two feed ids must be distinct — comparing a feed to itself proves nothing, and the CLI refuses it outside this demo path.

## Worked example (invented output)

```text
compare — feed-x vs feed-y  window 300s from 2026-08-25T14:00:00.000Z

ticks      a=18,204  b=17,655
matched    17,391  (95.53% of a, 98.50% of b)
unique     only-a=813  only-b=264
nbbo       a=100.00%  b=91.20% of ticks carried a quote
ts skew    median 12ms  p95 187ms  min -3ms  max 902ms (b.ts − a.ts on matched prints)

condition disagreements (2, capped at 50):
  contract              ts                        a            b
  NVDA260918C00200000   2026-08-25T14:03:11.412Z  iso          regular
  SPY260918P00640000    2026-08-25T14:41:02.008Z  spread-leg   regular

prints only on feed-x (showing 20 of 813):
  NVDA260918C00200000   2026-08-25T14:02:59.101Z     40 @     2.55  ex X
  …
```

How to read it: feed-y is missing ~4.5% of what feed-x delivered in this window — worth a support ticket with the sampled prints attached, and worth re-running at another time of day before concluding anything. The +12 ms median skew is ordinary reporting-path latency. The `spread-leg` vs `regular` disagreement is the most actionable line: on feed-y that print would score as directional flow; on feed-x it is correctly excluded as a strategy leg.

## Determinism and testing

Live comparison is wall-clock inherently — two real vendor streams over a shared window can never be replayed exactly. For deterministic use (and all of this repo's tests), point `compareFeeds` at replay/synthetic adapters: given the same input streams the report is byte-identical (the collection loop preserves arrival order and the matcher breaks every tie deterministically).

The programmatic API is exported from core:

```ts
import { compareFeeds } from "@luxalgo/whale-core";

const report = await compareFeeds({
  a: { id: "feed-x", adapter: adapterA },
  b: { id: "feed-y", adapter: adapterB },
  underlyings: ["NVDA"],
  durationMs: 60_000,
  matchToleranceMs: 1000,
});
```
