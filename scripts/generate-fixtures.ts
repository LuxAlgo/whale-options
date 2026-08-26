/*
  Fixture generator — `pnpm gen:fixtures`.

  Writes the committed quality-gate fixtures:

    fixtures/tapes/*.ndjson  — OptionTradeTick tapes, one JSON tick per line
    fixtures/goldens/*.json  — the FULL FlowEvent stream each tape classifies
                               to under the goldens config (testConfig():
                               minPremium 0, so every event is asserted)

  Two tape sources, neither of which is recorded market data:

    - seeded SyntheticFeed runs (pinned seed + pinned 09:30 ET start ⇒ the
      same bytes on every machine, forever),
    - hand-built edge tapes that each pin one classification behavior the
      engine must never regress on (sweep aggregation, spread-leg silence,
      cancel voiding, late prints, liquidity-bucketed block floors, cold
      start, ladders, session rollover).

  Goldens are produced by reading each tape back through ReplayFeed +
  normalizeTrade — the exact path `whale replay --file` uses — so a golden is
  what replaying the committed tape must produce, byte for byte, with empty
  baselines. Everything here is deterministic: running the generator twice
  is a no-op. packages/core/test/goldens.test.ts enforces byte equality (and
  the edge tapes' semantics) in CI; `UPDATE_GOLDENS=1 vitest run goldens`
  rewrites goldens alone after an intended classification change.
*/

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OptionTradeTick } from "../packages/core/src/types.js";
import { easternTimeToUtc } from "../packages/core/src/util/session.js";
import {
  collectSyntheticTicks,
  makeTick,
  readTapeTicks,
  resetSeq,
  runEngineOver,
  T0,
} from "../packages/core/test/helpers.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TAPES_DIR = join(ROOT, "fixtures", "tapes");
const GOLDENS_DIR = join(ROOT, "fixtures", "goldens");

// ---------------------------------------------------------------------------
// Hand-built edge tapes. Each returns a fresh tick array (seq restarts at 0).
// Default makeTick contract: NVDA 2026-09-18 C 200 @ nbbo 2.45×2.50, so a
// print at 2.50 is buy-at-ask and a print between the quotes is "mid".
// ---------------------------------------------------------------------------

/** ≥2 prints, ≥2 exchanges, one rolling window ⇒ exactly one sweep event. */
function edgeSweep3Exchanges(): OptionTradeTick[] {
  resetSeq();
  return [
    makeTick({ ts: T0, exchange: "C", price: 2.5, size: 40, conditions: ["iso"] }),
    makeTick({ ts: T0 + 120, exchange: "N", price: 2.5, size: 60 }),
    makeTick({ ts: T0 + 260, exchange: "Q", price: 2.51, size: 30 }), // through the ask
  ];
}

/** A vertical: two spread legs. They count volume but must emit nothing. */
function edgeSpreadLegs(): OptionTradeTick[] {
  resetSeq();
  return [
    makeTick({ ts: T0, exchange: "C", price: 2.48, size: 500, conditions: ["spread-leg"] }),
    makeTick({
      ts: T0,
      exchange: "C",
      price: 1.2,
      size: 500,
      conditions: ["spread-leg"],
      contract: { underlying: "NVDA", expiry: "2026-09-18", right: "C", strike: 210 },
      nbbo: { bid: 1.15, ask: 1.25, bidSize: 40, askSize: 40, ts: T0 - 100 },
    }),
  ];
}

/** A cancel inside the open window voids its leg: the would-be 2-exchange
 *  sweep downgrades to a single print of the surviving 25-lot. */
function edgeCancelInWindow(): OptionTradeTick[] {
  resetSeq();
  return [
    makeTick({ ts: T0, exchange: "C", price: 2.5, size: 50 }),
    makeTick({ ts: T0 + 80, exchange: "N", price: 2.5, size: 25 }),
    makeTick({ ts: T0 + 160, exchange: "C", price: 2.5, size: 50, conditions: ["cancel"] }),
  ];
}

/** Late reports: still blocks on size, never a sweep, side always unknown. */
function edgeLatePrint(): OptionTradeTick[] {
  resetSeq();
  return [
    makeTick({ ts: T0, exchange: "C", price: 2.5, size: 600, conditions: ["late"] }),
    makeTick({ ts: T0 + 100, exchange: "N", price: 2.5, size: 600, conditions: ["late"] }),
  ];
}

/** The same 60-lot is a block on an illiquid contract (clears the illiquid
 *  bucket floor of 50) but plain volume on a liquid one (low-bucket floor
 *  100). The two spread legs only exist to give the liquid contract enough
 *  day volume to leave the illiquid bucket — they must not flag either. */
function edgeIlliquidBlock(): OptionTradeTick[] {
  resetSeq();
  const liquid = { underlying: "NVDA", expiry: "2026-09-18", right: "C" as const, strike: 195 };
  const farLeg = { underlying: "NVDA", expiry: "2026-09-18", right: "C" as const, strike: 205 };
  const illiquid = { underlying: "NVDA", expiry: "2026-09-18", right: "C" as const, strike: 250 };
  const liquidNbbo = (ts: number) => ({
    bid: 6.0,
    ask: 6.2,
    bidSize: 60,
    askSize: 60,
    ts: ts - 100,
  });
  return [
    // Vertical on the liquid strike: 300 contracts of volume, zero events.
    makeTick({
      ts: T0,
      exchange: "C",
      price: 6.1,
      size: 300,
      conditions: ["spread-leg"],
      contract: liquid,
      nbbo: liquidNbbo(T0),
      oi: 20000,
    }),
    makeTick({
      ts: T0,
      exchange: "C",
      price: 3.0,
      size: 300,
      conditions: ["spread-leg"],
      contract: farLeg,
      nbbo: { bid: 2.9, ask: 3.1, bidSize: 40, askSize: 40, ts: T0 - 100 },
      oi: 9000,
    }),
    // Liquid contract, 60-lot mid print: day volume 360 ⇒ low bucket, floor 100 ⇒ print.
    makeTick({
      ts: T0 + 5000,
      exchange: "N",
      price: 6.1,
      size: 60,
      contract: liquid,
      nbbo: liquidNbbo(T0 + 5000),
      oi: 20000,
    }),
    // Illiquid contract, same 60-lot mid print: day volume 60 ⇒ illiquid bucket, floor 50 ⇒ block.
    makeTick({
      ts: T0 + 8000,
      exchange: "N",
      price: 0.3,
      size: 60,
      contract: illiquid,
      nbbo: { bid: 0.28, ask: 0.32, bidSize: 30, askSize: 30, ts: T0 + 8000 - 100 },
      oi: 40,
    }),
  ];
}

/** A single scored print with empty baselines ⇒ the score flags coldStart. */
function edgeColdStart(): OptionTradeTick[] {
  resetSeq();
  return [makeTick({ ts: T0, exchange: "C", price: 2.5, size: 30 })];
}

/** 4 same-side clips worked over 6 minutes on one venue ⇒ 4 prints + 1 split. */
function edgeLadderSplit(): OptionTradeTick[] {
  resetSeq();
  return [0, 2, 4, 6].map((min) =>
    makeTick({ ts: T0 + min * 60_000, exchange: "C", price: 2.5, size: 30 }),
  );
}

/** Two sessions on one tape: day 1 folds into baselines at rollover, so the
 *  day-2 event on the same contract carries baselineDays 1 (still coldStart). */
function edgeSessionRollover(): OptionTradeTick[] {
  resetSeq();
  const day2 = easternTimeToUtc("2026-08-25", 10, 0);
  return [
    makeTick({ ts: T0, exchange: "C", price: 2.5, size: 30 }),
    makeTick({ ts: day2, exchange: "N", price: 2.5, size: 30 }),
  ];
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(TAPES_DIR, { recursive: true });
  mkdirSync(GOLDENS_DIR, { recursive: true });

  const tapes: Array<{ name: string; ticks: OptionTradeTick[] }> = [
    // Seeded synthetic tapes: broad, statistically-plausible coverage.
    { name: "mixed-1500", ticks: await collectSyntheticTicks({ seed: 11, maxEvents: 1500 }) },
    {
      name: "quiet-600",
      ticks: await collectSyntheticTicks({ seed: 23, maxEvents: 600, regime: "quiet" }),
    },
    // Hand-built edge tapes: one pinned behavior each.
    { name: "edge-sweep-3-exchanges", ticks: edgeSweep3Exchanges() },
    { name: "edge-spread-legs", ticks: edgeSpreadLegs() },
    { name: "edge-cancel-in-window", ticks: edgeCancelInWindow() },
    { name: "edge-late-print", ticks: edgeLatePrint() },
    { name: "edge-illiquid-block", ticks: edgeIlliquidBlock() },
    { name: "edge-cold-start", ticks: edgeColdStart() },
    { name: "edge-ladder-split", ticks: edgeLadderSplit() },
    { name: "edge-session-rollover", ticks: edgeSessionRollover() },
  ];

  for (const { name, ticks } of tapes) {
    const tapePath = join(TAPES_DIR, `${name}.ndjson`);
    writeFileSync(tapePath, `${ticks.map((t) => JSON.stringify(t)).join("\n")}\n`);

    // Golden = engine over the tape as replayed, not over the in-memory ticks:
    // byte-equal to what the goldens test (and `whale replay`) computes.
    const replayed = await readTapeTicks(tapePath);
    if (replayed.length !== ticks.length) {
      throw new Error(`${name}: replay returned ${replayed.length}/${ticks.length} ticks`);
    }
    const events = runEngineOver(replayed);
    writeFileSync(join(GOLDENS_DIR, `${name}.json`), `${JSON.stringify(events, null, 2)}\n`);

    const kinds = new Map<string, number>();
    for (const e of events) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
    const summary =
      [...kinds.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, n]) => `${n} ${k}`)
        .join(", ") || "no events";
    console.log(`${name}: ${ticks.length} ticks -> ${events.length} events (${summary})`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
