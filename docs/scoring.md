# The whale score

Every event carries a score from 0 to 100 and, more importantly, the complete decomposition that produced it: six components, each with its value, its weight, its contribution in points, and the raw inputs it was computed from. Components whose inputs are unavailable go `null`, are listed in `missing`, and the remaining weights renormalize — the score never silently pretends it knew something it didn't.

This document states each component's formula exactly as implemented in [`packages/core/src/score/score.ts`](../packages/core/src/score/score.ts). All sample numbers in this document come from the seeded synthetic feed.

Notation: `clamp01(x)` clamps to `[0, 1]`. Defaults in parentheses; every one of them lives in config under `score.*` (table at the end).

## How the total is assembled

1. Each component produces `value ∈ [0, 1]` or `null` (with a note saying why).
2. Let `active` = components with a non-null value, `W = Σ weight(active)`.
3. Each active component contributes `weighted = value × weight × 100 / W` points.
4. `total = Σ weighted`, rounded to one decimal. Null components are listed in `missing`.

So the points always sum to the total, and a missing component redistributes its weight proportionally across the components that had real inputs. If every component is missing, the total is 0 — not a guess.

**Cold start is a flag, not a fudge factor.** `coldStart = baselineDays < minBaselineDays` (5), where `baselineDays` is how many prior sessions of history this contract has. It never changes the number; it changes how much you should trust it. It appears in the score payload, in the reasons trail, as the `*` in CLI output — and alert rules skip cold-start events by default (`excludeColdStart: true`).

## The six components

### 1. `volumeVsBaseline` — weight 0.2

*Is this contract trading far above its own normal?*

- **Inputs:** `dayVolume` — the contract's session volume including this event's legs; `avgDailyVolume` — the mean of its daily volumes over up to `lookbackDays` (20) prior sessions.
- **Formula:** `value = clamp01( ln(max(1, dayVolume / avgDailyVolume)) / ln(volumeMult) )` with `caps.volumeMult` (20).
- **Missing when** the contract has no prior-session volume baseline (`avgDailyVolume` null or ≤ 0) — the expected state for a fresh contract or a fresh install.
- **What raises it:** day volume as a multiple of the contract's own average, log-scaled: 1× or below scores 0, 20× or more scores 1.0. Log scaling means going from 2× to 4× matters as much as 5× to 10× — one more doubling.
- **Raw reported:** `dayVolume`, `avgDailyVolume`, `multiple`, `capMultiple`.

### 2. `premiumVsBaseline` — weight 0.2

*How big is this premium for this underlying?*

- **Inputs:** the event's total premium (price × size × 100, summed over legs) placed in the underlying's premium distribution — the prior `lookbackDays` sessions' distributions merged with today-so-far. The distribution is a fixed log-bucketed histogram ($50 to $50M, 48 buckets), so the percentile is interpolated, deterministic, and mergeable across days.
- **Formula:** `value = clamp01(percentile)` where percentile is the fraction of sampled premiums ≤ this one.
- **Missing when** the distribution holds fewer than `minPremiumSamples` (50) samples — a percentile over a dozen prints is noise, so it is not reported.
- **What raises it:** being in the top of the underlying's own premium distribution. $500K is unremarkable on an index and enormous on a small name; this component is what makes that difference explicit.
- **Raw reported:** `premium`, `percentile`, `samples`.

### 3. `volOi` — weight 0.15

*Is today's volume large against existing open interest?*

- **Inputs:** `dayVolume` (as above) and the contract's open interest `oi` (from the feed's chain snapshot, riding on the tick).
- **Formula:** `ratio = dayVolume / oi`; `value = clamp01( log2(1 + ratio) / log2(1 + volOi) )` with `caps.volOi` (4).
- **Missing when** OI is unavailable or zero (e.g. a feed that does not provide open interest — the component says so rather than defaulting).
- **What raises it:** volume that dwarfs existing open interest. Ratio above 1 means more contracts traded today than existed yesterday — likely opening flow, and the raw output flags it: `openingFlowLikely: "yes"`.
- **Raw reported:** `dayVolume`, `oi`, `ratio`, `capRatio`, `openingFlowLikely`.

### 4. `aggression` — weight 0.2

*How did the order hit the quote?*

- **Inputs:** the aggressor side and through-quote flag from NBBO inference (see [classification.md](classification.md)), the event kind, and ISO corroboration.
- **Formula:** a base by execution style, plus bonuses, clamped to 1:
  - side `unknown` → `aggression.unknown` (0), with the note `aggressor side unknown`
  - side `mid` → `aggression.mid` (0.2)
  - at the quote → `aggression.atQuote` (0.7)
  - through the quote → `aggression.throughQuote` (1.0)
  - `+ aggression.sweepBonus` (0.2) if the event is a sweep
  - `+ aggression.isoBonus` (0.1) if any leg was ISO-flagged
- **Never missing** — an unknown side is a legitimate answer worth 0, not an absent input.
- **What raises it:** paying up. Lifting the ask beats printing mid; printing through the ask beats lifting it; doing it across exchanges at once (sweep) with ISO-marked legs is the ceiling.
- **Raw reported:** `side`, `throughQuote`, `kind`, `isoCorroborated`.

### 5. `urgency` — weight 0.1

*Short-dated and out of the money?*

- **Inputs:** `dte` — fractional days from the event to expiry (options expire 4 p.m. ET on expiry date); `otmPct` — how far out of the money the strike is as a fraction of spot (calls: `(strike − spot) / spot`; puts: `(spot − strike) / spot`; negative = in the money).
- **Formula:** `dteFactor = exp(−dte / dteTauDays)` with `urgency.dteTauDays` (10) — an e-folding, so 10 DTE scores ~0.37, 30 DTE ~0.05. Then:
  - spot known: `otmFactor = clamp01(otmPct / otmScale)` with `urgency.otmScale` (0.15); `value = clamp01( dteFactor × (0.4 + 0.6 × otmFactor) )`
  - spot unknown: `value = clamp01(dteFactor × 0.4)` with the note `spot unknown — OTM distance unavailable, DTE factor only`
- **What raises it:** near-dated contracts far out of the money — the "needs to be right, soon, by a lot" shape. In-the-money strikes get `otmFactor = 0` and keep only the 0.4 DTE base.
- **Raw reported:** `dte`, `dteFactor`, `otmPct`, `otmFactor`.

### 6. `repetition` — weight 0.15

*Has this direction kept hitting all session?*

- **Inputs:** `contractHits` — prior same-side scored events on this exact contract this session, before this one; `underlyingHits` — same, on the underlying. Only `buy`/`sell` events count and increment; `mid`/`unknown` do neither. Counters reset at session rollover.
- **Formula:** `hits = contractHits + 0.5 × underlyingHits`; `value = clamp01( log2(1 + hits) / log2(1 + repetition) )` with `caps.repetition` (8).
- **What raises it:** the same direction repeating — most strongly on the same contract, at half strength anywhere on the underlying. Log-scaled: the 2nd hit matters more than the 9th.
- **Raw reported:** `contractHits`, `underlyingHits`, `weightedHits`, `capHits`.

## Where the baselines come from

Components 1–3 lean on rolling baselines maintained by the engine and persisted in the flight recorder per session date:

- per-contract daily volume (up to 20 sessions) → `volumeVsBaseline` and the liquidity bucket used by block thresholds,
- per-underlying premium distribution (log histogram) → `premiumVsBaseline`,
- per-liquidity-bucket trade-size distribution → dynamic block thresholds (see [classification.md](classification.md)).

Sessions fold forward at rollover (and at shutdown), and a starting engine hydrates from the store. Until a contract has `minBaselineDays` (5) of history, its scores carry `coldStart: true`. Cold start is a first-class state, not an error — the engine works from the first tick and tells you exactly how warm it is.

## Worked example — captured output

A sweep from the seeded synthetic demo (`whale run --feed synthetic --verbose`):

```text
09:30:23  SWEEP  BUY   AMD   C $162.5 09-11    983 @    8.97     $882K  score  67*   6 legs/6 exch
    score breakdown:
      volumeVsBaseline   —      (no volume baseline for this contract yet)
      premiumVsBaseline  —      (premium distribution too thin (12/50 samples))
      volOi              ██████████··  20.3 pts  dayVolume=983 oi=365 ratio=2.693 capRatio=4 openingFlowLikely=yes
      aggression         ████████████  33.3 pts  side=buy throughQuote=no kind=sweep isoCorroborated=yes
      urgency            █···········   1.1 pts  dte=18.27 dteFactor=0.161 otmPct=-0.0156 otmFactor=0
      repetition         ██████······  12.5 pts  contractHits=0 underlyingHits=4 weightedHits=2 capHits=8
```

Recomputing it by hand:

- Missing: `volumeVsBaseline` (no prior sessions) and `premiumVsBaseline` (12 < 50 samples). Active weights: `0.15 + 0.2 + 0.1 + 0.15 = 0.6`.
- `volOi`: ratio `983 / 365 = 2.693` → `log2(3.693) / log2(5) = 0.8117` → `0.8117 × 0.15 × 100 / 0.6 = 20.3 pts`.
- `aggression`: at-ask buy `0.7` + sweep bonus `0.2` + ISO bonus `0.1` = `1.0` → `1.0 × 0.2 × 100 / 0.6 = 33.3 pts`.
- `urgency`: `exp(−18.27 / 10) = 0.161`; `otmPct = −0.0156` (slightly ITM) → `otmFactor 0` → `0.161 × 0.4 = 0.0644` → `0.0644 × 0.1 × 100 / 0.6 = 1.1 pts`.
- `repetition`: `hits = 0 + 0.5 × 4 = 2` → `log2(3) / log2(9) = 0.5` → `0.5 × 0.15 × 100 / 0.6 = 12.5 pts`.
- Total: `20.3 + 33.3 + 1.1 + 12.5 = 67.2` → **score 67.2**, flagged cold start (0 of 5 baseline sessions).

Every number above is reproducible from the raw inputs shown in the event itself. That is the point.

## Defaults

All knobs live in config under `score.*` and can be changed in `whale.config.ts`; the engine is deterministic, so `whale replay --diff` shows exactly what a change would have done to past sessions ([replay.md](replay.md)).

| Key | Default | Meaning |
|---|---|---|
| `weights.volumeVsBaseline` | 0.2 | component weight |
| `weights.premiumVsBaseline` | 0.2 | component weight |
| `weights.volOi` | 0.15 | component weight |
| `weights.aggression` | 0.2 | component weight |
| `weights.urgency` | 0.1 | component weight |
| `weights.repetition` | 0.15 | component weight |
| `caps.volumeMult` | 20 | day-volume multiple of the 20d average that maps to 1.0 |
| `caps.volOi` | 4 | volume/OI ratio that maps to 1.0 (log-scaled) |
| `caps.repetition` | 8 | weighted same-session hits that map to 1.0 (log-scaled) |
| `aggression.atQuote` | 0.7 | base value for at-quote executions |
| `aggression.throughQuote` | 1.0 | base value for through-quote executions |
| `aggression.mid` | 0.2 | base value for mid prints |
| `aggression.unknown` | 0 | base value when the side is unknown |
| `aggression.sweepBonus` | 0.2 | added when the event is a sweep |
| `aggression.isoBonus` | 0.1 | added when ISO legs corroborate |
| `urgency.dteTauDays` | 10 | e-folding of the DTE factor, in days |
| `urgency.otmScale` | 0.15 | OTM distance (fraction of spot) that maps to 1.0 |
| `minBaselineDays` | 5 | fewer baseline sessions than this ⇒ `coldStart` |
| `minPremiumSamples` | 50 | premium percentile needs at least this many samples |
| `lookbackDays` | 20 | rolling baseline lookback, in sessions |

Weights need not sum to 1 — renormalization makes only their ratios matter. Example override:

```ts
// whale.config.ts
import { defineConfig } from "@luxalgo/whale-core";

export default defineConfig({
  score: {
    weights: { aggression: 0.3, urgency: 0.05 },
    caps: { volOi: 6 },
  },
});
```
