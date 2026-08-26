/*
  Fixed log-bucketed histogram — the baseline substrate. Chosen over exact
  percentile structures because it is (a) deterministic, (b) mergeable across
  days by summing counts, and (c) serializes to a few hundred bytes per
  underlying per day in the flight recorder.
*/

export interface SerializedHistogram {
  min: number;
  max: number;
  counts: number[];
  /** Count of samples below min (folded into bucket 0 for quantiles). */
  under: number;
  /** Count of samples above max (folded into the last bucket). */
  over: number;
}

export class LogHistogram {
  readonly min: number;
  readonly max: number;
  readonly buckets: number;
  private counts: number[];
  private under = 0;
  private over = 0;
  private readonly logMin: number;
  private readonly logSpan: number;

  constructor(min: number, max: number, buckets: number) {
    if (min <= 0 || max <= min || buckets < 2) throw new Error("invalid histogram bounds");
    this.min = min;
    this.max = max;
    this.buckets = buckets;
    this.counts = new Array(buckets).fill(0);
    this.logMin = Math.log(min);
    this.logSpan = Math.log(max) - this.logMin;
  }

  get total(): number {
    return this.counts.reduce((a, b) => a + b, 0) + this.under + this.over;
  }

  private bucketOf(value: number): number {
    const frac = (Math.log(value) - this.logMin) / this.logSpan;
    return Math.min(this.buckets - 1, Math.max(0, Math.floor(frac * this.buckets)));
  }

  add(value: number, n = 1): void {
    if (!Number.isFinite(value) || n <= 0) return;
    if (value < this.min) {
      this.under += n;
      return;
    }
    if (value >= this.max) {
      this.over += n;
      return;
    }
    const i = this.bucketOf(value);
    this.counts[i] = (this.counts[i] ?? 0) + n;
  }

  merge(other: LogHistogram): void {
    if (other.buckets !== this.buckets || other.min !== this.min || other.max !== this.max) {
      throw new Error("cannot merge histograms with different bounds");
    }
    for (let i = 0; i < this.buckets; i++) {
      this.counts[i] = (this.counts[i] ?? 0) + (other.counts[i] ?? 0);
    }
    this.under += other.under;
    this.over += other.over;
  }

  /** Lower edge of bucket i in value space. */
  private edge(i: number): number {
    return Math.exp(this.logMin + (i / this.buckets) * this.logSpan);
  }

  /** q ∈ [0,1] → interpolated value; null when empty. */
  quantile(q: number): number | null {
    const total = this.total;
    if (total === 0) return null;
    const target = Math.min(total, Math.max(0, q * total));
    let cum = this.under;
    if (target <= cum) return this.min;
    for (let i = 0; i < this.buckets; i++) {
      const c = this.counts[i] ?? 0;
      if (c > 0 && target <= cum + c) {
        const within = (target - cum) / c;
        const lo = this.edge(i);
        const hi = this.edge(i + 1);
        return lo + within * (hi - lo);
      }
      cum += c;
    }
    return this.max;
  }

  /** Fraction of samples ≤ value (interpolated within the bucket). */
  percentileOf(value: number): number | null {
    const total = this.total;
    if (total === 0) return null;
    if (value < this.min) return this.under > 0 ? this.under / total / 2 : 0;
    if (value >= this.max) return (total - this.over / 2) / total;
    const i = this.bucketOf(value);
    let below = this.under;
    for (let j = 0; j < i; j++) below += this.counts[j] ?? 0;
    const c = this.counts[i] ?? 0;
    const lo = this.edge(i);
    const hi = this.edge(i + 1);
    const within = c * Math.min(1, Math.max(0, (value - lo) / (hi - lo)));
    return (below + within) / total;
  }

  serialize(): SerializedHistogram {
    return {
      min: this.min,
      max: this.max,
      counts: [...this.counts],
      under: this.under,
      over: this.over,
    };
  }

  static deserialize(s: SerializedHistogram): LogHistogram {
    const h = new LogHistogram(s.min, s.max, s.counts.length);
    h.counts = [...s.counts];
    h.under = s.under;
    h.over = s.over;
    return h;
  }

  clone(): LogHistogram {
    return LogHistogram.deserialize(this.serialize());
  }
}

/** Premium distribution: $50 .. $50M, 48 log buckets. */
export function newPremiumHistogram(): LogHistogram {
  return new LogHistogram(50, 50_000_000, 48);
}

/** Trade-size distribution: 1 .. 100k contracts, 34 log buckets. */
export function newSizeHistogram(): LogHistogram {
  return new LogHistogram(1, 100_000, 34);
}
