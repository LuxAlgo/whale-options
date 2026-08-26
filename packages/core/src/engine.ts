/*
  The engine: a pure, synchronous state machine. Ticks in, FlowEvents out.

  No I/O, no wall clock, no randomness — every decision is a function of the
  tick stream, the config, and the baseline state it was constructed with.
  That single property buys everything downstream: byte-identical replay,
  golden tests, and a flight recorder whose stories can be re-run.

  The async world (feeds, stores, alert sinks, servers) lives in runner.ts.
*/
import { inferAggressor } from "./classify/aggressor.js";
import { type BlockThreshold, Classifier, type ProtoEvent } from "./classify/classifier.js";
import { isCancel, isSpreadLeg, policyFor } from "./conditions.js";
import type { WhaleConfig } from "./config.js";
import {
  type BaselineDayRows,
  BaselineState,
  bucketFor,
  IntradayState,
} from "./score/baselines.js";
import { computeScore } from "./score/score.js";
import type {
  EngineStats,
  FlowEvent,
  OptionTradeTick,
  ScoreComponentName,
  Side,
  WhaleScore,
} from "./types.js";
import { eventId } from "./util/hash.js";
import { newPremiumHistogram, newSizeHistogram } from "./util/log-histogram.js";
import { dteOf, round, sessionDateOf } from "./util/session.js";

export class Engine {
  private readonly classifier: Classifier;
  private intraday = new IntradayState();
  private repetition = new Map<string, number>();
  private sessionDate: string | null = null;
  private pendingDayRows: BaselineDayRows[] = [];
  private folded = false;
  private stats: EngineStats = {
    ticksSeen: 0,
    ticksCounted: 0,
    eventsEmitted: 0,
    eventsSuppressed: 0,
    cancelsApplied: 0,
    sweepsResolved: 0,
    openWindows: 0,
    sessionDate: null,
  };

  constructor(
    private readonly cfg: WhaleConfig,
    private readonly baselines: BaselineState = BaselineState.empty(cfg.score.lookbackDays),
  ) {
    this.classifier = new Classifier(
      {
        sweepWindowMs: cfg.engine.sweepWindowMs,
        ladderMinClips: cfg.engine.ladder.minClips,
        ladderWindowMs: cfg.engine.ladder.windowMs,
        ladderMinClipSize: cfg.engine.ladder.minClipSize,
      },
      (tick) => this.blockThresholdFor(tick),
    );
  }

  /** Feed one normalized tick through; returns the events it resolved. */
  push(tick: OptionTradeTick): FlowEvent[] {
    const out: FlowEvent[] = [];
    this.stats.ticksSeen++;

    // Session rollover: close the old day completely before touching the new one.
    const date = sessionDateOf(tick.ts);
    if (this.sessionDate === null) {
      this.sessionDate = date;
      this.stats.sessionDate = date;
    } else if (date !== this.sessionDate) {
      out.push(...this.finalizeProtos(this.classifier.flush()));
      this.rollSession();
      this.sessionDate = date;
      this.stats.sessionDate = date;
    }

    const policy = policyFor(tick.conditions);

    if (isCancel(tick.conditions)) {
      out.push(...this.finalizeProtos(this.classifier.resolveDue(tick.ts)));
      const voided = this.classifier.applyCancel(tick);
      this.intraday.removeVolume(tick.contract, tick.size);
      if (voided !== null) this.stats.cancelsApplied++;
      return out;
    }

    if (policy.countsVolume) {
      this.intraday.addVolume(tick.contract, tick.size);
      this.stats.ticksCounted++;
      if (policy.scoreEligible) {
        this.intraday.addPremiumSample(tick.underlying, tick.price * tick.size * 100);
        this.intraday.addSizeSample(this.bucketOf(tick), tick.size);
      }
    }

    if (!policy.scoreEligible) {
      // Spread legs, auctions, crosses: recorded, counted, never scored.
      out.push(...this.finalizeProtos(this.classifier.resolveDue(tick.ts)));
      if (this.cfg.engine.emit.spreadLegs && isSpreadLeg(tick.conditions)) {
        const excluded = this.finalizeExcluded(
          tick,
          "spread leg: excluded from scoring (multi-leg strategy print)",
        );
        if (excluded) out.push(excluded);
      }
      return out;
    }

    const agg = inferAggressor(tick, policy, this.cfg.engine.nbboStaleMs);
    out.push(...this.finalizeProtos(this.classifier.push(tick, policy, agg)));
    return out;
  }

  /** Resolve open windows (deadline ≤ uptoTs; default all). Call at stream end. */
  flush(uptoTs = Number.POSITIVE_INFINITY): FlowEvent[] {
    return this.finalizeProtos(this.classifier.flush(uptoTs));
  }

  /** Day rows produced by session rollovers since the last drain. */
  drainDayRows(): BaselineDayRows[] {
    const rows = this.pendingDayRows;
    this.pendingDayRows = [];
    return rows;
  }

  /** Fold the in-progress session for persistence at shutdown (idempotent). */
  closeSession(): BaselineDayRows | null {
    if (this.folded || this.sessionDate === null) return null;
    this.folded = true;
    return this.intraday.fold(this.sessionDate);
  }

  getStats(): EngineStats {
    return { ...this.stats, openWindows: this.classifier.openWindowCount };
  }

  private rollSession(): void {
    if (this.sessionDate !== null) {
      const rows = this.intraday.fold(this.sessionDate);
      this.pendingDayRows.push(rows);
      this.baselines.applyDay(rows);
    }
    this.intraday = new IntradayState();
    this.repetition.clear();
  }

  private bucketOf(tick: OptionTradeTick) {
    const avg =
      this.baselines.avgDailyVolume(tick.contract) ?? this.intraday.volumeOf(tick.contract);
    return bucketFor(avg, this.cfg.engine.block.bucketBounds);
  }

  private blockThresholdFor(tick: OptionTradeTick): BlockThreshold {
    const bucket = this.bucketOf(tick);
    const floor = this.cfg.engine.block.minSize[bucket];
    const prior = this.baselines.sizeHistogram(bucket);
    const intradayHist = this.intraday.sizeHist.get(bucket);
    let dynamic: number | null = null;
    if (prior || intradayHist) {
      const combined = prior ? prior.clone() : newSizeHistogram();
      if (intradayHist) combined.merge(intradayHist);
      dynamic = combined.total >= 200 ? combined.quantile(this.cfg.engine.block.quantile) : null;
    }
    if (dynamic === null) {
      return { threshold: floor, bucket, source: "bucket floor (size distribution still thin)" };
    }
    const threshold = Math.max(floor, Math.ceil(dynamic));
    return {
      threshold,
      bucket,
      source: `p${(this.cfg.engine.block.quantile * 100).toFixed(1)} of ${bucket}-bucket sizes, floored at ${floor}`,
    };
  }

  private finalizeProtos(protos: ProtoEvent[]): FlowEvent[] {
    const out: FlowEvent[] = [];
    for (const proto of protos) out.push(...this.finalize(proto));
    return out;
  }

  private finalize(proto: ProtoEvent): FlowEvent[] {
    const legs = proto.legs;
    const first = legs[0];
    const last = legs[legs.length - 1];
    if (!first || !last) return [];
    if (proto.kind === "sweep") this.stats.sweepsResolved++;

    const premium = legs.reduce((acc, l) => acc + l.price * l.size * 100, 0);
    const size = legs.reduce((acc, l) => acc + l.size, 0);
    const vwap = size > 0 ? premium / (size * 100) : first.price;
    const spot = last.spot ?? first.spot ?? null;
    const oi = last.oi ?? first.oi ?? null;
    const dte = dteOf(last.ts, last.expiry);
    const otmPct =
      spot !== null && spot > 0
        ? last.right === "C"
          ? (last.strike - spot) / spot
          : (spot - last.strike) / spot
        : null;
    const dayVolume = this.intraday.volumeOf(last.contract);
    const volOiRatio = oi !== null && oi > 0 ? dayVolume / oi : null;

    // Premium percentile against prior days + today so far (in that order).
    const priorHist = this.baselines.premiumHistogram(last.underlying);
    const todayHist = this.intraday.premiumHist.get(last.underlying);
    let premiumPercentile: number | null = null;
    let premiumSamples = 0;
    if (priorHist || todayHist) {
      const combined = priorHist ? priorHist.clone() : newPremiumHistogram();
      if (todayHist) combined.merge(todayHist);
      premiumSamples = combined.total;
      premiumPercentile = combined.percentileOf(premium);
    }

    const repC = this.repetition.get(`c|${last.contract}|${proto.side}`) ?? 0;
    const repU = this.repetition.get(`u|${last.underlying}|${proto.side}`) ?? 0;

    const score = computeScore(this.cfg.score, {
      kind: proto.kind,
      side: proto.side,
      premium,
      dte,
      otmPct,
      throughQuote: proto.throughQuote,
      iso: proto.iso,
      dayVolume,
      avgDailyVolume: this.baselines.avgDailyVolume(last.contract),
      coverageDays: this.baselines.coverageDays(last.contract),
      premiumPercentile,
      premiumSamples,
      oi,
      repetitionContract: repC,
      repetitionUnderlying: repU,
    });

    if (proto.side === "buy" || proto.side === "sell") {
      this.repetition.set(`c|${last.contract}|${proto.side}`, repC + 1);
      this.repetition.set(`u|${last.underlying}|${proto.side}`, repU + 1);
    }

    const reasons = [...proto.reasons];
    if (legs.some((l) => l.conditions.includes("unknown"))) {
      reasons.push(
        "carries an unmapped vendor sale condition: treated as regular, flagged for review",
      );
    }
    if (score.coldStart) {
      reasons.push(
        `cold start: ${score.baselineDays}/${this.cfg.score.minBaselineDays} baseline sessions; score uncertainty is wider`,
      );
    }

    const event: FlowEvent = {
      id: eventId({
        kind: proto.kind,
        side: proto.side,
        contract: last.contract,
        firstSeq: first.seq,
        legSummaries: legs.map((l) => ({
          ts: l.ts,
          price: l.price,
          size: l.size,
          exchange: l.exchange,
        })),
      }),
      ts: last.ts,
      sessionDate: this.sessionDate ?? sessionDateOf(last.ts),
      kind: proto.kind,
      side: proto.side as Side,
      underlying: last.underlying,
      contract: last.contract,
      expiry: last.expiry,
      strike: last.strike,
      right: last.right,
      legs,
      legCount: legs.length,
      premium: round(premium, 2),
      size,
      price: round(vwap, 4),
      dte: round(dte, 3),
      otmPct: otmPct === null ? null : round(otmPct, 4),
      spot,
      volOiRatio: volOiRatio === null ? null : round(volOiRatio, 3),
      oi,
      exchanges: [...new Set(legs.map((l) => l.exchange))],
      score,
      reasons,
      feedId: last.feedId,
      seq: first.seq,
    };

    if (event.premium < this.cfg.engine.emit.minPremium) {
      this.stats.eventsSuppressed++;
      return [];
    }
    this.stats.eventsEmitted++;
    return [event];
  }

  /**
   * Opt-in emission for score-ineligible prints (engine.emit.spreadLegs):
   * the event exists for the record with an explicitly empty score — every
   * component null and noted — because inventing a directional score for a
   * strategy leg is exactly the false positive this engine refuses to emit.
   */
  private finalizeExcluded(tick: OptionTradeTick, reason: string): FlowEvent | null {
    const premium = tick.price * tick.size * 100;
    if (premium < this.cfg.engine.emit.minPremium) {
      this.stats.eventsSuppressed++;
      return null;
    }
    const spot = tick.spot;
    const otmPct =
      spot !== null && spot > 0
        ? tick.right === "C"
          ? (tick.strike - spot) / spot
          : (spot - tick.strike) / spot
        : null;
    const dayVolume = this.intraday.volumeOf(tick.contract);
    const volOiRatio = tick.oi !== null && tick.oi > 0 ? dayVolume / tick.oi : null;
    const names: ScoreComponentName[] = [
      "volumeVsBaseline",
      "premiumVsBaseline",
      "volOi",
      "aggression",
      "urgency",
      "repetition",
    ];
    const components = {} as WhaleScore["components"];
    for (const name of names) {
      components[name] = {
        value: null,
        weight: this.cfg.score.weights[name],
        weighted: null,
        raw: {},
        note: "not scored: spread leg",
      };
    }
    const coverage = this.baselines.coverageDays(tick.contract);
    this.stats.eventsEmitted++;
    return {
      id: eventId({
        kind: "print",
        side: "unknown",
        contract: tick.contract,
        firstSeq: tick.seq,
        legSummaries: [
          { ts: tick.ts, price: tick.price, size: tick.size, exchange: tick.exchange },
        ],
      }),
      ts: tick.ts,
      sessionDate: this.sessionDate ?? sessionDateOf(tick.ts),
      kind: "print",
      side: "unknown",
      underlying: tick.underlying,
      contract: tick.contract,
      expiry: tick.expiry,
      strike: tick.strike,
      right: tick.right,
      legs: [tick],
      legCount: 1,
      premium: round(premium, 2),
      size: tick.size,
      price: tick.price,
      dte: round(dteOf(tick.ts, tick.expiry), 3),
      otmPct: otmPct === null ? null : round(otmPct, 4),
      spot,
      volOiRatio: volOiRatio === null ? null : round(volOiRatio, 3),
      oi: tick.oi,
      exchanges: [tick.exchange],
      score: {
        total: 0,
        components,
        missing: names,
        baselineDays: coverage,
        coldStart: coverage < this.cfg.score.minBaselineDays,
      },
      reasons: [reason],
      feedId: tick.feedId,
      seq: tick.seq,
    };
  }
}
