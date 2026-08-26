import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../src/engine.js";
import type { FlowEvent } from "../src/types.js";
import { makeTick, resetSeq, T0, testConfig } from "./helpers.js";

function run(ticks: ReturnType<typeof makeTick>[]): FlowEvent[] {
  const engine = new Engine(testConfig());
  const out: FlowEvent[] = [];
  for (const t of ticks) out.push(...engine.push(t));
  out.push(...engine.flush());
  return out;
}

beforeEach(resetSeq);

describe("sweep detection", () => {
  it("aggregates same-side prints across ≥2 exchanges within the window into one sweep", () => {
    const events = run([
      makeTick({ ts: T0, exchange: "C", price: 2.5, size: 40, conditions: ["iso"] }),
      makeTick({ ts: T0 + 120, exchange: "N", price: 2.5, size: 60 }),
      makeTick({ ts: T0 + 260, exchange: "Q", price: 2.51, size: 30 }),
    ]);
    expect(events).toHaveLength(1);
    const sweep = events[0]!;
    expect(sweep.kind).toBe("sweep");
    expect(sweep.side).toBe("buy");
    expect(sweep.legCount).toBe(3);
    expect(sweep.size).toBe(130);
    expect(sweep.exchanges.sort()).toEqual(["C", "N", "Q"]);
    expect(sweep.premium).toBeCloseTo((2.5 * 40 + 2.5 * 60 + 2.51 * 30) * 100, 6);
    expect(sweep.reasons.join(" ")).toContain("sweep: 3 legs across 3 exchanges");
    expect(sweep.reasons.join(" ")).toContain("ISO");
  });

  it("does not sweep a same-exchange burst — each print resolves alone", () => {
    const events = run([
      makeTick({ ts: T0, exchange: "C", size: 20 }),
      makeTick({ ts: T0 + 100, exchange: "C", size: 25 }),
      makeTick({ ts: T0 + 200, exchange: "C", size: 30 }),
    ]);
    expect(events).toHaveLength(3);
    for (const e of events) expect(e.kind).toBe("print");
  });

  it("keeps buy and sell windows separate", () => {
    const events = run([
      makeTick({ ts: T0, exchange: "C", price: 2.5, size: 40 }), // at ask → buy
      makeTick({ ts: T0 + 50, exchange: "N", price: 2.45, size: 40 }), // at bid → sell
      makeTick({ ts: T0 + 100, exchange: "Q", price: 2.5, size: 40 }), // buy leg 2
      makeTick({ ts: T0 + 150, exchange: "X", price: 2.45, size: 40 }), // sell leg 2
    ]);
    const sweeps = events.filter((e) => e.kind === "sweep");
    expect(sweeps).toHaveLength(2);
    expect(new Set(sweeps.map((s) => s.side))).toEqual(new Set(["buy", "sell"]));
  });

  it("closes the rolling window once the gap exceeds sweepWindowMs", () => {
    const events = run([
      makeTick({ ts: T0, exchange: "C", size: 40 }),
      makeTick({ ts: T0 + 700, exchange: "N", size: 40 }), // 700ms later: new window
    ]);
    expect(events.filter((e) => e.kind === "sweep")).toHaveLength(0);
    expect(events.filter((e) => e.kind === "print")).toHaveLength(2);
  });
});

describe("condition policies", () => {
  it("never emits events for spread legs", () => {
    const events = run([
      makeTick({ ts: T0, conditions: ["spread-leg"], size: 500 }),
      makeTick({
        ts: T0,
        conditions: ["spread-leg"],
        size: 500,
        contract: { underlying: "NVDA", expiry: "2026-09-18", right: "C", strike: 210 },
      }),
    ]);
    expect(events).toHaveLength(0);
  });

  it("late prints stay out of sweeps and carry unknown side, but can still be blocks", () => {
    const events = run([
      makeTick({ ts: T0, exchange: "C", size: 600, conditions: ["late"] }),
      makeTick({ ts: T0 + 100, exchange: "N", size: 600, conditions: ["late"] }),
    ]);
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.kind).toBe("block");
      expect(e.side).toBe("unknown");
      expect(e.reasons.join(" ")).toContain("not trustworthy");
    }
  });

  it("a cancel voids its matching leg inside an open window", () => {
    const events = run([
      makeTick({ ts: T0, exchange: "C", price: 2.5, size: 50 }),
      makeTick({ ts: T0 + 80, exchange: "N", price: 2.5, size: 25 }),
      makeTick({ ts: T0 + 160, exchange: "C", price: 2.5, size: 50, conditions: ["cancel"] }),
    ]);
    // With the 50-lot voided only the 25-lot remains — no sweep, one print.
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("print");
    expect(events[0]!.size).toBe(25);
  });
});

describe("blocks and ladders", () => {
  it("flags a large single print as a block with the threshold in reasons", () => {
    const events = run([makeTick({ ts: T0, size: 1200 })]);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("block");
    expect(events[0]!.reasons.join(" ")).toMatch(/block: size 1200 ≥ threshold \d+/);
  });

  it("fires a split event when clips ladder over minutes on one venue", () => {
    const clips = [0, 2, 4, 6].map((min) =>
      makeTick({ ts: T0 + min * 60_000, exchange: "C", size: 30 }),
    );
    const events = run(clips);
    const prints = events.filter((e) => e.kind === "print");
    const splits = events.filter((e) => e.kind === "split");
    expect(prints).toHaveLength(4);
    expect(splits).toHaveLength(1);
    expect(splits[0]!.legCount).toBe(4);
    expect(splits[0]!.reasons.join(" ")).toContain("ladder: 4 same-side clips");
  });

  it("does not double-count: every print/block/sweep leg seq appears exactly once", () => {
    const ticks = [
      makeTick({ ts: T0, exchange: "C", size: 40 }),
      makeTick({ ts: T0 + 90, exchange: "N", size: 45 }),
      makeTick({ ts: T0 + 1500, exchange: "C", size: 700 }),
      makeTick({ ts: T0 + 3000, exchange: "Q", size: 12 }),
    ];
    const events = run(ticks);
    const seqs = events.filter((e) => e.kind !== "split").flatMap((e) => e.legs.map((l) => l.seq));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(new Set(seqs)).toEqual(new Set(ticks.map((t) => t.seq)));
  });
});
