/*
  Property tests — invariants that must hold on ANY tape, not just the
  committed goldens. Each property runs over several seeded synthetic tapes
  (deterministic, so failures are reproducible by seed):

  - accounting: print|block|sweep legs never double-count a print, and on a
    cancel-free tape they partition the score-eligible ticks exactly
    (splits are excluded by design — their legs reference clips that
    already printed, see docs/architecture.md);
  - premium conservation follows from that partition: Σ event premium over
    print|block|sweep equals Σ price×size×100 over score-eligible ticks;
  - the NDJSON round trip (TapeWriter → ReplayFeed → normalizeTrade)
    reproduces the tick stream and therefore the event stream, byte for
    byte — the property `whale replay` stands on;
  - emission-time inversions are bounded by the sweep window: a print held
    as a potential sweep leg resolves at most sweepWindowMs of event time
    after later immediate prints, so an event's ts can trail the running
    maximum by at most that window (and never precedes its own legs);
  - every score is a transparent decomposition: total ∈ [0,100], the
    weighted components sum to it, and missing components carry notes.
*/
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isCancel, policyFor } from "../src/conditions.js";
import { TapeWriter } from "../src/feeds/replay.js";
import type { FlowEvent, OptionTradeTick } from "../src/types.js";
import { collectSyntheticTicks, readTapeTicks, runEngineOver, testConfig } from "./helpers.js";

const SEEDS = [5, 17, 29];
const TAPE_EVENTS = 1200;

const tapeCache = new Map<number, Promise<OptionTradeTick[]>>();
function tapeFor(seed: number): Promise<OptionTradeTick[]> {
  let hit = tapeCache.get(seed);
  if (!hit) {
    hit = collectSyntheticTicks({ seed, maxEvents: TAPE_EVENTS });
    tapeCache.set(seed, hit);
  }
  return hit;
}

function scoredLegSeqs(events: FlowEvent[]): number[] {
  return events.filter((e) => e.kind !== "split").flatMap((e) => e.legs.map((l) => l.seq));
}

describe("tapes actually exercise the filters", () => {
  it("the seeded tapes contain spread legs and at least one cancel", async () => {
    const all = (await Promise.all(SEEDS.map(tapeFor))).flat();
    expect(all.some((t) => policyFor(t.conditions).scoreEligible === false)).toBe(true);
    expect(all.some((t) => isCancel(t.conditions))).toBe(true);
  });
});

describe("no double-count", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: every print|block|sweep leg seq appears at most once`, async () => {
      const events = runEngineOver(await tapeFor(seed));
      expect(events.length).toBeGreaterThan(0);
      const seqs = scoredLegSeqs(events);
      expect(new Set(seqs).size).toBe(seqs.length);
    });

    it(`seed ${seed}: cancel-free tape ⇒ legs are exactly the score-eligible seqs`, async () => {
      const cancelFree = (await tapeFor(seed)).filter((t) => !isCancel(t.conditions));
      const events = runEngineOver(cancelFree);
      const seqs = scoredLegSeqs(events);
      expect(new Set(seqs).size).toBe(seqs.length);
      const eligible = new Set(
        cancelFree.filter((t) => policyFor(t.conditions).scoreEligible).map((t) => t.seq),
      );
      expect(new Set(seqs)).toEqual(eligible);
    });
  }
});

describe("premium conservation (cancel-free tapes)", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: Σ print|block|sweep premium = Σ price×size×100 over eligible ticks`, async () => {
      const cancelFree = (await tapeFor(seed)).filter((t) => !isCancel(t.conditions));
      const events = runEngineOver(cancelFree);
      const emitted = events
        .filter((e) => e.kind !== "split")
        .reduce((acc, e) => acc + e.premium, 0);
      const expected = cancelFree
        .filter((t) => policyFor(t.conditions).scoreEligible)
        .reduce((acc, t) => acc + t.price * t.size * 100, 0);
      expect(expected).toBeGreaterThan(0);
      expect(Math.abs(emitted - expected)).toBeLessThanOrEqual(1e-6 * Math.max(emitted, expected));
    });
  }
});

describe("replay identity (NDJSON round trip)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "whale-properties-"));
  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

  for (const seed of SEEDS) {
    it(`seed ${seed}: TapeWriter → ReplayFeed reproduces ticks and events byte-for-byte`, async () => {
      const original = await tapeFor(seed);
      const tapePath = join(tmpDir, `tape-${seed}.ndjson`);
      const writer = new TapeWriter(tapePath);
      for (const tick of original) writer.write(tick);
      await writer.close();

      // feedId is a normalization argument, not tape content — hold it at the
      // recording feed's id so the comparison isolates the NDJSON round trip.
      const replayed = await readTapeTicks(tapePath, "synthetic");
      expect(replayed.length).toBe(original.length);
      expect(JSON.stringify(replayed)).toBe(JSON.stringify(original));

      const a = runEngineOver(original);
      const b = runEngineOver(replayed);
      expect(a.length).toBeGreaterThan(0);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    });
  }
});

describe("event-time monotonicity bound", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: ts never precedes an event's own legs; inversions ≤ sweepWindowMs`, async () => {
      const config = testConfig();
      const events = runEngineOver(await tapeFor(seed), config);
      expect(events.length).toBeGreaterThan(0);
      // Bound, not strict order: a print held in a sweep window resolves up
      // to sweepWindowMs of event time after immediate prints that followed
      // it, so emission order may trail the running max by that window.
      let runningMax = Number.NEGATIVE_INFINITY;
      for (const event of events) {
        for (const leg of event.legs) {
          expect(event.ts).toBeGreaterThanOrEqual(leg.ts);
        }
        expect(runningMax - event.ts).toBeLessThanOrEqual(config.engine.sweepWindowMs);
        runningMax = Math.max(runningMax, event.ts);
      }
    });
  }
});

describe("score sanity", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: totals in [0,100], components sum to total, missing carry notes`, async () => {
      const events = runEngineOver(await tapeFor(seed));
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        const { score } = event;
        expect(score.total).toBeGreaterThanOrEqual(0);
        expect(score.total).toBeLessThanOrEqual(100);
        const weightedSum = Object.values(score.components).reduce(
          (acc, c) => acc + (c.weighted ?? 0),
          0,
        );
        expect(Math.abs(weightedSum - score.total)).toBeLessThanOrEqual(0.5);
        for (const [name, component] of Object.entries(score.components)) {
          if (component.value === null) {
            expect(score.missing).toContain(name);
            expect(component.note).toBeTruthy();
          } else {
            expect(score.missing).not.toContain(name);
          }
        }
      }
    });
  }
});
