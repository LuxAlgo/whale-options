# Classification

How prints become events: aggressor inference, sweep windows, dynamic block thresholds, ladder/split detection, sale-condition policy, and cancel handling — exactly as implemented in [`packages/core/src/classify/`](../packages/core/src/classify/) and [`conditions.ts`](../packages/core/src/conditions.ts).

One property governs all of it: **the classifier is event-time only.** Windows open and close on print timestamps (`tick.ts`), never the wall clock, which is why the engine is a pure function of the tape and why replay is byte-identical ([replay.md](replay.md)). All sample lines in this document are captured from the seeded synthetic feed.

## Aggressor inference

The side of every print is judged against the NBBO captured at print time — and that exact quote is stored on the tick, so the call remains auditable forever.

| Print price vs NBBO | Side | `throughQuote` |
|---|---|---|
| ≥ ask | `buy` | true if strictly above the ask |
| ≤ bid | `sell` | true if strictly below the bid |
| between | `mid` | false |

Comparisons use an epsilon of 1e-9 so float representation never flips a side. The result is `unknown` — never guessed — in exactly three cases:

1. **No NBBO on the print** (the feed had no quote to attach).
2. **Staleness bound:** the quote's age `tick.ts − nbbo.ts` exceeds `engine.nbboStaleMs` (default 5000 ms), or is more than 1000 ms *negative* (a quote stamped after the print by more than a second indicates clock disagreement — not trustworthy either).
3. **The sale condition voids the timestamp** (`forceUnknownSide` in the policy table below): late, out-of-sequence, auction, cross, reopening, cancel.

Each outcome ships a human-readable reason with the numbers used, e.g.:

```text
aggressor buy: 8.97 at ask 8.97 (nbbo 8.81×8.97, 327ms old)
aggressor mid: 16.06 between 15.92×16.19 (nbbo 15.92×16.19, 67ms old)
aggressor unknown: print-time NBBO not trustworthy for this sale condition
```

(The staleness case produces `aggressor unknown: NBBO <age>ms from print exceeds staleness bound <bound>ms`, with the actual ages filled in.)

## Sweep windows

**Definition:** same contract, same aggressor side, ≥ 2 prints across ≥ 2 exchanges inside a rolling window of `engine.sweepWindowMs` (default 500 ms).

Mechanics, in the order they matter:

- **Only directional, sweep-eligible prints enter windows.** A `mid`/`unknown` print, or one whose conditions bar sweeps (floor, late, …), resolves immediately on its own (and may still be a block).
- **Rolling window:** a window keyed `contract|side` opens with deadline `tick.ts + sweepWindowMs`; every joining leg pushes the deadline forward. A burst that keeps printing keeps the window alive.
- **Hold until resolve, no double-count:** prints that might become sweep legs are *held* until the window resolves. A held print either becomes a sweep leg or resolves as its own event — never both. This is enforced by a property test: on cancel-free tapes, the legs of `print`/`block`/`sweep` events exactly partition the score-eligible ticks.
- **Resolution is event-time:** windows resolve when a later print's timestamp passes their deadline, in a stable order (deadline, then first-leg sequence number). At stream end or session rollover, remaining windows flush. In live mode only, an idle flusher force-resolves open windows when the stream goes quiet in wall time — it can only *resolve* windows, never change their membership, so a replayed tape classifies identically.
- **Bounded out-of-order emission:** because legs are held, emission order can trail strict tape order — but only boundedly. An event's timestamp can trail the running maximum by at most the sweep window, and never precedes its own legs (property-tested).
- **Resolution outcome:** ≥ 2 legs on ≥ 2 distinct exchanges ⇒ one sweep event (legs sorted by time, VWAP price, summed premium). Anything else ⇒ each held leg resolves individually. ISO-flagged legs add a corroboration reason and feed the score's ISO bonus — corroboration, not the definition.

```text
sweep: 6 legs across 6 exchanges in 312ms
ISO-flagged legs corroborate an intermarket sweep
```

## Dynamic block thresholds

A block is a single print whose size clears a threshold that adapts to the contract's liquidity — fixed thresholds are how flow tools flag routine prints on illiquid names and miss real blocks on liquid ones.

1. **Bucket the contract** by its own 20-session average daily volume (when no baseline exists yet, today's volume so far): bounds `engine.block.bucketBounds` (default `[200, 2000, 20000]`) split contracts into `illiquid` / `low` / `mid` / `high`.
2. **Take the percentile** `engine.block.quantile` (default 0.995) of that bucket's trade-size distribution — prior sessions' histograms merged with today so far. The distribution must hold at least 200 samples to be used.
3. **Floor it:** `threshold = max(bucketFloor, ceil(percentile))` with floors `engine.block.minSize` (defaults: illiquid 50, low 100, mid 250, high 500). With a thin distribution, the floor alone applies.

Every block states its arithmetic in the reasons trail, including which source produced the threshold:

```text
block: size 2210 ≥ threshold 250 (mid bucket, bucket floor (size distribution still thin))
block: size 1897 ≥ threshold 1848 (low bucket, p99.5 of low-bucket sizes, floored at 100)
```

Prints whose conditions are not block-eligible (spread legs, auctions, crosses, cancels, reopenings) never become blocks regardless of size.

## Split / ladder detection

The sweep's slower sibling: an order worked over minutes instead of milliseconds.

- Directional prints of at least `engine.ladder.minClipSize` (5) contracts are tracked per `contract|side` over a rolling `engine.ladder.windowMs` (default 600,000 ms = 10 minutes).
- When `engine.ladder.minClips` (4) or more clips accumulate inside the window **and** the burst spans more than 4× the sweep window, a `split` event fires with those clips as its legs, and the tracker resets for that key. A burst tighter than that is sweep territory, not a worked ladder — no split fires.

```text
ladder: 4 same-side clips worked over 3.1m across 4 venues
```

**Split legs overlap prints by design.** Each clip already resolved as its own event (print, block, or sweep leg) when it happened — retracting them after the fact would break the no-retraction rule below. The split is an *additional* pattern-level event referencing those prints. Consequence: premium totals across all events double-count splits, so accounting (and the repo's premium-conservation property tests) runs over `print`/`block`/`sweep` only.

## The sale-condition policy table

OPRA sale conditions arrive vendor-encoded; each adapter maps its codes onto a normalized vocabulary (that mapping duty, with citations, is described in [feeds.md](feeds.md)). This table — [`conditions.ts`](../packages/core/src/conditions.ts), verbatim — decides what each print may do:

| Condition | May be scored | May join sweeps | Block-eligible | Counts volume | Forces side unknown |
|---|---|---|---|---|---|
| `regular` | yes | yes | yes | yes | no |
| `iso` | yes | yes | yes | yes | no |
| `auto` | yes | yes | yes | yes | no |
| `spread-leg` | **no** | no | no | yes | no |
| `spread-leg-equity` | **no** | no | no | yes | no |
| `auction` | no | no | no | yes | **yes** |
| `cross` | no | no | no | yes | **yes** |
| `floor` | yes | **no** | yes | yes | no |
| `cancel` | no | no | no | **no** | yes |
| `late` | yes | **no** | yes | yes | **yes** |
| `out-of-sequence` | yes | **no** | yes | yes | **yes** |
| `reopening` | no | no | no | yes | yes |
| `unknown` | yes | yes | yes | yes | no |

Rules of combination:

- A print carrying several conditions is **only as eligible as its most restrictive one**: eligibilities AND together, `forceUnknownSide` ORs.
- A print with no conditions is `regular`.
- The reasoning behind the non-obvious rows:
  - **Spread legs** print real volume (they count toward baselines and day volume) but are not directional flow — treating a multi-leg strategy's legs as conviction sweeps is the classic retail-flow false positive. They are never scored, never sweep, never block.
  - **Floor trades** are legitimate blocks but report slowly and never sweep.
  - **Late / out-of-sequence** prints keep block eligibility — a late-reported block is a real signal — but their timestamps cannot anchor a sweep window or a side call.
  - **Unmapped vendor codes** normalize to `unknown` and stay eligible: silently dropping unknowns would bias the tape. Every event built on one carries the reason `carries an unmapped vendor sale condition — treated as regular, flagged for review`.

## Cancel handling — and its documented limits

A print carrying a cancel condition never becomes an event and never counts volume. On arrival it does three things, at its own event time:

1. Resolves any windows whose deadlines have passed.
2. **Voids a matching leg still inside an open sweep window** — same contract, same price, same size — checking buy then sell windows, most-recently-added leg first. An emptied window is dropped. A voided leg is gone before resolution, so it can neither form nor join a sweep.
3. Decrements the contract's day volume by the canceled size (floored at zero), keeping volume-derived inputs honest.

**The limits, stated plainly:**

- **No retraction after emission.** Once an event has been emitted, a later cancel does not un-emit it or adjust it; the cancel's remaining effect is the volume decrement. Emission is monotone — that is what makes the stream appendable, alertable, and byte-identically replayable. Same tape ⇒ same emitted stream, cancels included.
- Cancel matching is by (contract, price, size) within the open window only; a cancel referencing a print that already resolved has no classification effect.

## Emission floor

After classification and scoring, events with premium below `engine.emit.minPremium` (default $10,000) are suppressed — classified, counted in engine stats, but not emitted. Raise or lower it in config or with `--min-premium`.

Spread legs are never scored, but `engine.emit.spreadLegs: true` (default false) emits them anyway as `print` events with side `unknown` and an explicitly empty score — every component null with a "not scored: spread leg" note — for users who want strategy prints on the record without inventing a directional signal for them. The premium floor still applies.

## Session rollover

On the first tick of a new session date (US/Eastern, computed without environment-dependent locale machinery), the engine flushes open windows, folds the finished session's intraday accumulations into the rolling baselines, and resets day volume and repetition counters. Rollovers happen in event time too, so multi-day tapes replay deterministically.

## Config reference

| Key | Default | Meaning |
|---|---|---|
| `engine.sweepWindowMs` | 500 | rolling multi-exchange sweep window (per contract + side) |
| `engine.nbboStaleMs` | 5000 | NBBO older than this vs the print ⇒ side `unknown` |
| `engine.block.quantile` | 0.995 | percentile of the bucket's trade-size distribution |
| `engine.block.minSize` | 50 / 100 / 250 / 500 | per-bucket threshold floors (illiquid / low / mid / high) |
| `engine.block.bucketBounds` | [200, 2000, 20000] | 20d-avg daily volume bounds separating the buckets |
| `engine.ladder.minClips` | 4 | clips required to fire a split |
| `engine.ladder.windowMs` | 600000 | ladder lookback (10 minutes) |
| `engine.ladder.minClipSize` | 5 | minimum clip size to be tracked |
| `engine.emit.minPremium` | 10000 | emission floor, premium dollars |
| `engine.emit.spreadLegs` | false | emit spread legs as unscored `print`/`unknown` events |

## Appendix: OPRA exchange ids

Event legs carry single-letter exchange ids; the mapping used for display:

| Id | Venue | Id | Venue |
|---|---|---|---|
| A | NYSE American | M | MIAX |
| B | BOX | N | NYSE Arca |
| C | Cboe | O | OPRA |
| D | MIAX Emerald | P | MIAX Sapphire |
| E | Cboe EDGX | Q | Nasdaq |
| H | MIAX Pearl | T | Nasdaq BX |
| I | ISE | W | Cboe C2 |
| J | ISE Gemini | X | Nasdaq PHLX |
| | | Z | Cboe BZX |
