/*
  Golden tapes — the determinism contract as a tripwire. Every committed
  tape in fixtures/tapes must classify to the byte-identical FlowEvent
  stream committed in fixtures/goldens: same tape + same config ⇒ same
  bytes, ids included. Tapes are read back through ReplayFeed +
  normalizeTrade (the exact `whale replay --file` path, seq preserved) and
  run through a fresh engine with empty baselines under testConfig()
  (minPremium 0 — the full stream is asserted).

  Regenerating after an INTENDED classification change:

      UPDATE_GOLDENS=1 pnpm --filter @luxalgo/whale-core exec vitest run goldens

  (or `pnpm gen:fixtures`, which rewrites tapes + goldens together). The
  semantic assertions below run in update mode too, so a regeneration can
  never silently bless a regression on the edge tapes.
*/
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FlowEvent } from "../src/types.js";
import { readTapeTicks, runEngineOver } from "./helpers.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TAPES_DIR = join(ROOT, "fixtures", "tapes");
const GOLDENS_DIR = join(ROOT, "fixtures", "goldens");
const UPDATE = process.env.UPDATE_GOLDENS === "1";

const tapeNames = readdirSync(TAPES_DIR)
  .filter((f) => f.endsWith(".ndjson"))
  .map((f) => f.replace(/\.ndjson$/, ""))
  .sort();

// One engine run per tape, shared by the byte test and the semantic tests.
const cache = new Map<string, Promise<FlowEvent[]>>();
function eventsOf(name: string): Promise<FlowEvent[]> {
  let hit = cache.get(name);
  if (!hit) {
    hit = readTapeTicks(join(TAPES_DIR, `${name}.ndjson`)).then((ticks) => runEngineOver(ticks));
    cache.set(name, hit);
  }
  return hit;
}

describe("golden tapes: byte-identical event streams", () => {
  it("the committed tape set is complete", () => {
    expect(tapeNames).toEqual(
      [
        "mixed-1500",
        "quiet-600",
        "edge-sweep-3-exchanges",
        "edge-spread-legs",
        "edge-cancel-in-window",
        "edge-late-print",
        "edge-illiquid-block",
        "edge-cold-start",
        "edge-ladder-split",
        "edge-session-rollover",
      ].sort(),
    );
  });

  for (const name of tapeNames) {
    it(`${name}`, async () => {
      const serialized = `${JSON.stringify(await eventsOf(name), null, 2)}\n`;
      const goldenPath = join(GOLDENS_DIR, `${name}.json`);
      if (UPDATE) {
        writeFileSync(goldenPath, serialized);
        return;
      }
      const golden = readFileSync(goldenPath, "utf8");
      expect(serialized).toBe(golden);
    });
  }
});

/*
  Semantic expectations for the edge tapes, asserted independently of the
  golden bytes: these encode what each tape exists to prove, so regenerating
  the goldens cannot quietly re-bless changed behavior.
*/
describe("edge-tape semantics", () => {
  it("edge-sweep-3-exchanges: one sweep aggregating all three exchanges", async () => {
    const events = await eventsOf("edge-sweep-3-exchanges");
    expect(events).toHaveLength(1);
    const sweep = events[0]!;
    expect(sweep.kind).toBe("sweep");
    expect(sweep.side).toBe("buy");
    expect(sweep.legCount).toBe(3);
    expect(sweep.size).toBe(130);
    expect([...sweep.exchanges].sort()).toEqual(["C", "N", "Q"]);
    expect(sweep.reasons.join(" ")).toContain("3 legs across 3 exchanges");
  });

  it("edge-spread-legs: vertical legs never flag — zero events", async () => {
    expect(await eventsOf("edge-spread-legs")).toHaveLength(0);
  });

  it("edge-cancel-in-window: the cancel voids its leg — sweep downgrades to one print", async () => {
    const events = await eventsOf("edge-cancel-in-window");
    expect(events).toHaveLength(1);
    const survivor = events[0]!;
    expect(survivor.kind).toBe("print");
    expect(survivor.size).toBe(25);
    // The voided 50-lot (seq 0) appears in no event's legs.
    expect(events.flatMap((e) => e.legs.map((l) => l.seq))).toEqual([1]);
  });

  it("edge-late-print: late reports are blocks with unknown side, never sweeps", async () => {
    const events = await eventsOf("edge-late-print");
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.kind).toBe("block");
      expect(e.side).toBe("unknown");
    }
  });

  it("edge-illiquid-block: the same 60-lot flags only in the illiquid bucket", async () => {
    const events = await eventsOf("edge-illiquid-block");
    expect(events).toHaveLength(2);
    const onLiquid = events.find((e) => e.strike === 195);
    const onIlliquid = events.find((e) => e.strike === 250);
    expect(onLiquid?.kind).toBe("print"); // 60 < the low-bucket floor of 100
    expect(onLiquid?.size).toBe(60);
    expect(onIlliquid?.kind).toBe("block"); // 60 ≥ the illiquid-bucket floor of 50
    expect(onIlliquid?.size).toBe(60);
    expect(onIlliquid?.reasons.join(" ")).toContain("illiquid bucket");
  });

  it("edge-cold-start: every event is flagged coldStart with the reason attached", async () => {
    const events = await eventsOf("edge-cold-start");
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.score.coldStart).toBe(true);
      expect(e.score.baselineDays).toBe(0);
      expect(e.reasons.join(" ")).toContain("cold start");
    }
  });

  it("edge-ladder-split: 4 clips over minutes emit 4 prints plus one split", async () => {
    const events = await eventsOf("edge-ladder-split");
    expect(events.filter((e) => e.kind === "print")).toHaveLength(4);
    const splits = events.filter((e) => e.kind === "split");
    expect(splits).toHaveLength(1);
    expect(splits[0]!.legCount).toBe(4);
    expect(splits[0]!.reasons.join(" ")).toContain("ladder: 4 same-side clips");
  });

  it("edge-session-rollover: day 1 folds into baselines — day-2 events carry baselineDays 1", async () => {
    const events = await eventsOf("edge-session-rollover");
    const day1 = events.filter((e) => e.sessionDate === "2026-08-24");
    const day2 = events.filter((e) => e.sessionDate === "2026-08-25");
    expect(day1.length).toBeGreaterThan(0);
    expect(day2.length).toBeGreaterThan(0);
    for (const e of day1) expect(e.score.baselineDays).toBe(0);
    for (const e of day2) expect(e.score.baselineDays).toBe(1);
  });

  it("mixed-1500: the broad tape exercises sweeps, blocks and splits", async () => {
    const kinds = new Set((await eventsOf("mixed-1500")).map((e) => e.kind));
    expect(kinds.has("sweep")).toBe(true);
    expect(kinds.has("block")).toBe(true);
    expect(kinds.has("split")).toBe(true);
  });
});
