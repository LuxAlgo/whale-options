import { describe, expect, it } from "vitest";
import { LogHistogram, newPremiumHistogram } from "../src/util/log-histogram.js";

describe("log histogram", () => {
  it("quantiles order correctly on a spread of samples", () => {
    const h = new LogHistogram(1, 100_000, 34);
    for (let i = 0; i < 1000; i++) h.add(10);
    for (let i = 0; i < 100; i++) h.add(500);
    for (let i = 0; i < 10; i++) h.add(20_000);
    const q50 = h.quantile(0.5) ?? 0;
    const q95 = h.quantile(0.95) ?? 0;
    const q999 = h.quantile(0.999) ?? 0;
    expect(q50).toBeGreaterThan(5);
    expect(q50).toBeLessThan(50);
    expect(q95).toBeGreaterThan(q50);
    expect(q999).toBeGreaterThan(1_000);
  });

  it("percentileOf is monotonic and bounded", () => {
    const h = newPremiumHistogram();
    for (let i = 1; i <= 5000; i++) h.add(100 * i);
    let prev = 0;
    for (const v of [500, 5_000, 50_000, 400_000]) {
      const p = h.percentileOf(v) ?? 0;
      expect(p).toBeGreaterThanOrEqual(prev);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
      prev = p;
    }
    expect(h.percentileOf(100_000_000)).toBeGreaterThan(0.99);
  });

  it("serialize/deserialize round-trips and merge sums counts", () => {
    const a = new LogHistogram(1, 1000, 10);
    const b = new LogHistogram(1, 1000, 10);
    a.add(5, 10);
    a.add(500, 2);
    b.add(5, 30);
    const restored = LogHistogram.deserialize(a.serialize());
    expect(restored.total).toBe(a.total);
    restored.merge(b);
    expect(restored.total).toBe(42);
    expect(() => restored.merge(new LogHistogram(1, 999, 10))).toThrow();
  });

  it("out-of-range samples land in under/over and still count", () => {
    const h = new LogHistogram(10, 100, 5);
    h.add(1);
    h.add(1_000);
    h.add(50);
    expect(h.total).toBe(3);
  });
});
