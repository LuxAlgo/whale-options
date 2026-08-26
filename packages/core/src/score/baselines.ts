/*
  Rolling baselines: what "normal" looks like, so the score can say how far
  from normal this print is. Three families, all persisted per session date
  in the flight recorder and folded forward day by day:

  - per-contract daily volume (20 sessions) → volumeVsBaseline + liquidity bucket
  - per-underlying premium distribution (log histogram) → premiumVsBaseline
  - per-liquidity-bucket trade-size distribution → dynamic block thresholds

  Cold start is a first-class state, not an error: fewer than minBaselineDays
  of history flags every score as coldStart so consumers can filter.
*/
import {
  LogHistogram,
  newPremiumHistogram,
  newSizeHistogram,
  type SerializedHistogram,
} from "../util/log-histogram.js";

export type LiquidityBucket = "illiquid" | "low" | "mid" | "high";

export interface ContractDay {
  date: string;
  volume: number;
  tradeCount: number;
}

export interface BaselineDayRows {
  sessionDate: string;
  contracts: Array<{ contract: string; volume: number; tradeCount: number }>;
  underlyingPremium: Array<{ underlying: string; histogram: SerializedHistogram }>;
  bucketSize: Array<{ bucket: LiquidityBucket; histogram: SerializedHistogram }>;
}

export function bucketFor(
  avgDailyVolume: number,
  bounds: [number, number, number],
): LiquidityBucket {
  if (avgDailyVolume < bounds[0]) return "illiquid";
  if (avgDailyVolume < bounds[1]) return "low";
  if (avgDailyVolume < bounds[2]) return "mid";
  return "high";
}

/** Prior-days state (never includes the in-progress session). */
export class BaselineState {
  private contractDays = new Map<string, ContractDay[]>();
  private premiumDays = new Map<string, Array<{ date: string; hist: LogHistogram }>>();
  private sizeDays = new Map<LiquidityBucket, Array<{ date: string; hist: LogHistogram }>>();
  private premiumMerged = new Map<string, LogHistogram>();
  private sizeMerged = new Map<LiquidityBucket, LogHistogram>();

  constructor(readonly lookbackDays: number) {}

  static empty(lookbackDays: number): BaselineState {
    return new BaselineState(lookbackDays);
  }

  /** Hydrate one prior session (oldest → newest ordering expected). */
  loadDay(rows: BaselineDayRows): void {
    for (const c of rows.contracts) {
      const days = this.contractDays.get(c.contract) ?? [];
      days.push({ date: rows.sessionDate, volume: c.volume, tradeCount: c.tradeCount });
      if (days.length > this.lookbackDays) days.shift();
      this.contractDays.set(c.contract, days);
    }
    for (const u of rows.underlyingPremium) {
      const days = this.premiumDays.get(u.underlying) ?? [];
      days.push({ date: rows.sessionDate, hist: LogHistogram.deserialize(u.histogram) });
      if (days.length > this.lookbackDays) days.shift();
      this.premiumDays.set(u.underlying, days);
    }
    for (const b of rows.bucketSize) {
      const days = this.sizeDays.get(b.bucket) ?? [];
      days.push({ date: rows.sessionDate, hist: LogHistogram.deserialize(b.histogram) });
      if (days.length > this.lookbackDays) days.shift();
      this.sizeDays.set(b.bucket, days);
    }
    this.premiumMerged.clear();
    this.sizeMerged.clear();
  }

  /** Fold a finished session forward — same shape as hydration. */
  applyDay(rows: BaselineDayRows): void {
    this.loadDay(rows);
  }

  coverageDays(contract: string): number {
    return this.contractDays.get(contract)?.length ?? 0;
  }

  avgDailyVolume(contract: string): number | null {
    const days = this.contractDays.get(contract);
    if (!days || days.length === 0) return null;
    return days.reduce((a, d) => a + d.volume, 0) / days.length;
  }

  premiumHistogram(underlying: string): LogHistogram | null {
    const cached = this.premiumMerged.get(underlying);
    if (cached) return cached;
    const days = this.premiumDays.get(underlying);
    if (!days || days.length === 0) return null;
    const merged = newPremiumHistogram();
    for (const d of days) merged.merge(d.hist);
    this.premiumMerged.set(underlying, merged);
    return merged;
  }

  sizeHistogram(bucket: LiquidityBucket): LogHistogram | null {
    const cached = this.sizeMerged.get(bucket);
    if (cached) return cached;
    const days = this.sizeDays.get(bucket);
    if (!days || days.length === 0) return null;
    const merged = newSizeHistogram();
    for (const d of days) merged.merge(d.hist);
    this.sizeMerged.set(bucket, merged);
    return merged;
  }
}

/** The in-progress session's accumulators. */
export class IntradayState {
  dayVolume = new Map<string, number>();
  dayTradeCount = new Map<string, number>();
  premiumHist = new Map<string, LogHistogram>();
  sizeHist = new Map<LiquidityBucket, LogHistogram>();

  addVolume(contract: string, size: number): void {
    this.dayVolume.set(contract, (this.dayVolume.get(contract) ?? 0) + size);
    this.dayTradeCount.set(contract, (this.dayTradeCount.get(contract) ?? 0) + 1);
  }

  removeVolume(contract: string, size: number): void {
    const cur = this.dayVolume.get(contract) ?? 0;
    this.dayVolume.set(contract, Math.max(0, cur - size));
  }

  addPremiumSample(underlying: string, premium: number): void {
    let h = this.premiumHist.get(underlying);
    if (!h) {
      h = newPremiumHistogram();
      this.premiumHist.set(underlying, h);
    }
    h.add(premium);
  }

  addSizeSample(bucket: LiquidityBucket, size: number): void {
    let h = this.sizeHist.get(bucket);
    if (!h) {
      h = newSizeHistogram();
      this.sizeHist.set(bucket, h);
    }
    h.add(size);
  }

  volumeOf(contract: string): number {
    return this.dayVolume.get(contract) ?? 0;
  }

  fold(sessionDate: string): BaselineDayRows {
    return {
      sessionDate,
      contracts: [...this.dayVolume.entries()].map(([contract, volume]) => ({
        contract,
        volume,
        tradeCount: this.dayTradeCount.get(contract) ?? 0,
      })),
      underlyingPremium: [...this.premiumHist.entries()].map(([underlying, hist]) => ({
        underlying,
        histogram: hist.serialize(),
      })),
      bucketSize: [...this.sizeHist.entries()].map(([bucket, hist]) => ({
        bucket,
        histogram: hist.serialize(),
      })),
    };
  }
}
