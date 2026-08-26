/*
  The classification state machine: sweeps, blocks, split/ladders, cancels.

  Everything is event-time driven — windows open and close on print
  timestamps, never the wall clock — which is what makes the classifier a
  pure function of the tape. Prints that might become sweep legs are held
  until their window resolves, so no print is ever counted both as a leg and
  as a standalone event.

  - Sweep: same contract, same aggressor side, ≥2 prints across ≥2 exchanges
    inside a rolling window (default 500ms). ISO conditions corroborate.
  - Block: single print ≥ a dynamic, liquidity-bucketed size threshold
    (percentile of the bucket's trade-size distribution, floored) — fixed
    thresholds are how flow tools end up flagging noise on illiquid names.
  - Split/ladder: ≥N same-contract same-side clips spread over minutes
    without multi-exchange simultaneity — the "iceberg worked over time".
  - Cancels void a matching leg still sitting in an open window; already
    emitted events are never retracted (documented; replay of the full tape
    reproduces the same emitted stream).
*/

import type { ConditionPolicy } from "../conditions.js";
import { hasIso } from "../conditions.js";
import type { EventKind, OptionTradeTick, Side } from "../types.js";
import type { AggressorResult } from "./aggressor.js";

export interface ProtoEvent {
  kind: EventKind;
  side: Side;
  legs: OptionTradeTick[];
  reasons: string[];
  throughQuote: boolean;
  iso: boolean;
}

export interface BlockThreshold {
  threshold: number;
  bucket: string;
  source: string;
}

export interface ClassifierConfig {
  sweepWindowMs: number;
  ladderMinClips: number;
  ladderWindowMs: number;
  ladderMinClipSize: number;
}

interface PendingLeg {
  tick: OptionTradeTick;
  side: "buy" | "sell";
  throughQuote: boolean;
  aggReason: string;
}

interface SweepWindow {
  contract: string;
  side: "buy" | "sell";
  legs: PendingLeg[];
  deadline: number;
}

interface LadderClip {
  tick: OptionTradeTick;
  kind: EventKind;
}

export class Classifier {
  private windows = new Map<string, SweepWindow>();
  private ladders = new Map<string, LadderClip[]>();

  constructor(
    private readonly cfg: ClassifierConfig,
    private readonly blockThresholdFor: (tick: OptionTradeTick) => BlockThreshold,
  ) {}

  get openWindowCount(): number {
    return this.windows.size;
  }

  /**
   * Feed one eligible (non-cancel, score-eligible) print through. Returns
   * proto-events resolved by this print's arrival: due windows first, then —
   * when the print can't join a sweep window — its own immediate resolution.
   */
  push(tick: OptionTradeTick, policy: ConditionPolicy, agg: AggressorResult): ProtoEvent[] {
    const out = this.resolveDue(tick.ts);
    const directional = agg.side === "buy" || agg.side === "sell";

    if (directional && policy.sweepEligible) {
      const side = agg.side as "buy" | "sell";
      const key = `${tick.contract}|${side}`;
      const existing = this.windows.get(key);
      const leg: PendingLeg = { tick, side, throughQuote: agg.throughQuote, aggReason: agg.reason };
      if (existing && existing.deadline >= tick.ts) {
        existing.legs.push(leg);
        existing.deadline = tick.ts + this.cfg.sweepWindowMs; // rolling window
      } else {
        if (existing) out.push(...this.resolveWindow(existing)); // stale same-key window
        this.windows.set(key, {
          contract: tick.contract,
          side,
          legs: [leg],
          deadline: tick.ts + this.cfg.sweepWindowMs,
        });
      }
      return out;
    }

    // Mid/unknown prints and sweep-ineligible conditions resolve immediately.
    out.push(
      ...this.resolveSingle(tick, agg.side, agg.throughQuote, [agg.reason], policy.blockEligible),
    );
    return out;
  }

  /** Resolve every window whose rolling deadline has passed. */
  resolveDue(nowTs: number): ProtoEvent[] {
    const out: ProtoEvent[] = [];
    const due: SweepWindow[] = [];
    for (const [key, w] of this.windows) {
      if (w.deadline < nowTs) {
        due.push(w);
        this.windows.delete(key);
      }
    }
    due.sort(
      (a, b) => a.deadline - b.deadline || (a.legs[0]?.tick.seq ?? 0) - (b.legs[0]?.tick.seq ?? 0),
    );
    for (const w of due) out.push(...this.resolveWindow(w));
    return out;
  }

  /** Force-resolve windows with deadline ≤ uptoTs (default: everything). */
  flush(uptoTs = Number.POSITIVE_INFINITY): ProtoEvent[] {
    const out: ProtoEvent[] = [];
    const all: SweepWindow[] = [];
    for (const [key, w] of this.windows) {
      if (w.deadline <= uptoTs) {
        all.push(w);
        this.windows.delete(key);
      }
    }
    all.sort(
      (a, b) => a.deadline - b.deadline || (a.legs[0]?.tick.seq ?? 0) - (b.legs[0]?.tick.seq ?? 0),
    );
    for (const w of all) out.push(...this.resolveWindow(w));
    return out;
  }

  /**
   * A cancel print: void the matching leg (same contract, price, size) still
   * sitting in an open window. Returns the voided size, or null.
   */
  applyCancel(tick: OptionTradeTick): number | null {
    for (const side of ["buy", "sell"] as const) {
      const w = this.windows.get(`${tick.contract}|${side}`);
      if (!w) continue;
      for (let i = w.legs.length - 1; i >= 0; i--) {
        const leg = w.legs[i];
        if (leg && leg.tick.price === tick.price && leg.tick.size === tick.size) {
          w.legs.splice(i, 1);
          if (w.legs.length === 0) this.windows.delete(`${tick.contract}|${side}`);
          return tick.size;
        }
      }
    }
    return null;
  }

  private resolveWindow(w: SweepWindow): ProtoEvent[] {
    const exchanges = new Set(w.legs.map((l) => l.tick.exchange));
    if (w.legs.length >= 2 && exchanges.size >= 2) {
      const legs = [...w.legs].sort((a, b) => a.tick.ts - b.tick.ts || a.tick.seq - b.tick.seq);
      const first = legs[0];
      const last = legs[legs.length - 1];
      if (!first || !last) return [];
      const iso = legs.some((l) => hasIso(l.tick.conditions));
      const reasons = [
        `sweep: ${legs.length} legs across ${exchanges.size} exchanges in ${last.tick.ts - first.tick.ts}ms`,
      ];
      if (iso) reasons.push("ISO-flagged legs corroborate an intermarket sweep");
      reasons.push(first.aggReason);
      return [
        {
          kind: "sweep",
          side: w.side,
          legs: legs.map((l) => l.tick),
          reasons,
          throughQuote: legs.some((l) => l.throughQuote),
          iso,
        },
      ];
    }
    // Not a sweep — each held leg resolves on its own (and may ladder).
    const out: ProtoEvent[] = [];
    for (const leg of [...w.legs].sort((a, b) => a.tick.seq - b.tick.seq)) {
      out.push(...this.resolveSingle(leg.tick, leg.side, leg.throughQuote, [leg.aggReason], true));
    }
    return out;
  }

  private resolveSingle(
    tick: OptionTradeTick,
    side: Side,
    throughQuote: boolean,
    reasons: string[],
    blockEligible: boolean,
  ): ProtoEvent[] {
    let kind: EventKind = "print";
    const extraReasons: string[] = [];
    if (blockEligible) {
      const t = this.blockThresholdFor(tick);
      if (tick.size >= t.threshold) {
        kind = "block";
        extraReasons.push(
          `block: size ${tick.size} ≥ threshold ${t.threshold} (${t.bucket} bucket, ${t.source})`,
        );
      }
    }
    const proto: ProtoEvent = {
      kind,
      side,
      legs: [tick],
      reasons: [...extraReasons, ...reasons],
      throughQuote,
      iso: hasIso(tick.conditions),
    };
    const out: ProtoEvent[] = [proto];
    const ladder = this.feedLadder(tick, side, kind);
    if (ladder) out.push(ladder);
    return out;
  }

  /** Track same-contract same-side clips over minutes; fire a split at N. */
  private feedLadder(tick: OptionTradeTick, side: Side, kind: EventKind): ProtoEvent | null {
    if (side !== "buy" && side !== "sell") return null;
    if (tick.size < this.cfg.ladderMinClipSize) return null;
    const key = `${tick.contract}|${side}`;
    const clips = this.ladders.get(key) ?? [];
    const cutoff = tick.ts - this.cfg.ladderWindowMs;
    const kept = clips.filter((c) => c.tick.ts >= cutoff);
    kept.push({ tick, kind });
    if (kept.length >= this.cfg.ladderMinClips) {
      // A burst on multiple venues is sweep territory, not a worked ladder.
      const exchanges = new Set(kept.map((c) => c.tick.exchange));
      const spanMs = tick.ts - (kept[0]?.tick.ts ?? tick.ts);
      const minutes = Math.round((spanMs / 60_000) * 10) / 10;
      if (spanMs > this.cfg.sweepWindowMs * 4) {
        this.ladders.delete(key);
        return {
          kind: "split",
          side,
          legs: kept.map((c) => c.tick),
          reasons: [
            `ladder: ${kept.length} same-side clips worked over ${minutes}m across ${exchanges.size} venue${exchanges.size > 1 ? "s" : ""}`,
          ],
          throughQuote: false,
          iso: false,
        };
      }
    }
    this.ladders.set(key, kept);
    return null;
  }
}
