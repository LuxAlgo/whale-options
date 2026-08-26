import { resolveConfig, type WhaleConfigInput } from "../src/config.js";
import { Engine } from "../src/engine.js";
import { ReplayFeed } from "../src/feeds/replay.js";
import { SyntheticFeed, type SyntheticOptions } from "../src/feeds/synthetic.js";
import { normalizeTrade } from "../src/normalize/normalize.js";
import { formatOcc } from "../src/occ.js";
import type { FeedId, FlowEvent, NormalizedCondition, OptionTradeTick } from "../src/types.js";
import { easternTimeToUtc } from "../src/util/session.js";

export const T0 = easternTimeToUtc("2026-08-24", 10, 0); // 10:00 ET on a Monday

/** Pinned session open used by fixture tapes and property tapes (09:30 ET). */
export const FIXTURE_START = easternTimeToUtc("2026-08-24", 9, 30);

let seqCounter = 0;

export function resetSeq(): void {
  seqCounter = 0;
}

export interface TickOverrides {
  ts?: number;
  contract?: { underlying: string; expiry: string; right: "C" | "P"; strike: number };
  price?: number;
  size?: number;
  exchange?: string;
  conditions?: NormalizedCondition[];
  nbbo?: OptionTradeTick["nbbo"];
  spot?: number | null;
  oi?: number | null;
  seq?: number;
}

export function makeTick(overrides: TickOverrides = {}): OptionTradeTick {
  const contract = overrides.contract ?? {
    underlying: "NVDA",
    expiry: "2026-09-18",
    right: "C" as const,
    strike: 200,
  };
  const ts = overrides.ts ?? T0;
  const price = overrides.price ?? 2.5;
  const nbbo =
    overrides.nbbo === undefined
      ? { bid: 2.45, ask: 2.5, bidSize: 50, askSize: 80, ts: ts - 100 }
      : overrides.nbbo;
  return {
    seq: overrides.seq ?? seqCounter++,
    ts,
    underlying: contract.underlying,
    contract: formatOcc(contract.underlying, contract.expiry, contract.right, contract.strike),
    expiry: contract.expiry,
    strike: contract.strike,
    right: contract.right,
    price,
    size: overrides.size ?? 10,
    exchange: overrides.exchange ?? "C",
    conditions: overrides.conditions ?? ["regular"],
    nbbo,
    spot: overrides.spot === undefined ? 195 : overrides.spot,
    oi: overrides.oi === undefined ? 5000 : overrides.oi,
    feedId: "synthetic",
  };
}

/** Engine config that emits everything — unit tests assert on the full stream. */
export function testConfig(extra: WhaleConfigInput = {}) {
  return resolveConfig({
    ...extra,
    engine: {
      ...(extra.engine ?? {}),
      emit: { minPremium: 0, spreadLegs: false, ...(extra.engine?.emit ?? {}) },
    },
  });
}

/**
 * Collect a seeded synthetic tape, normalized exactly as the runner would.
 * startTs defaults to FIXTURE_START so callers are deterministic by default.
 */
export async function collectSyntheticTicks(
  options: Pick<SyntheticOptions, "seed" | "regime" | "startTs"> & { maxEvents: number },
): Promise<OptionTradeTick[]> {
  const feed = new SyntheticFeed({
    startTs: FIXTURE_START,
    regime: "mixed",
    pace: "asap",
    ...options,
  });
  const ticks: OptionTradeTick[] = [];
  let seq = 0;
  for await (const raw of feed.subscribeOptionTrades({})) {
    const { tick } = normalizeTrade(raw, "synthetic", seq, (c) => feed.normalizeCondition(c));
    if (tick) {
      ticks.push(tick);
      seq++;
    }
  }
  return ticks;
}

/**
 * Read an NDJSON tape back through ReplayFeed + normalizeTrade — the exact
 * path `whale replay --file` takes (original seq values are preserved by the
 * tape rows). feedId defaults to "replay" to match the runner; pass the
 * recording feed's id to compare against the pre-serialization tick stream.
 */
export async function readTapeTicks(
  tapePath: string,
  feedId: FeedId = "replay",
): Promise<OptionTradeTick[]> {
  const feed = new ReplayFeed(tapePath);
  const ticks: OptionTradeTick[] = [];
  let seq = 0;
  for await (const raw of feed.subscribeOptionTrades({})) {
    const { tick } = normalizeTrade(raw, feedId, seq, (c) => feed.normalizeCondition(c));
    if (tick) {
      ticks.push(tick);
      seq++;
    }
  }
  return ticks;
}

/** Run a fresh engine (empty baselines) over a tape, flushing at stream end. */
export function runEngineOver(ticks: OptionTradeTick[], config = testConfig()): FlowEvent[] {
  const engine = new Engine(config);
  const out: FlowEvent[] = [];
  for (const tick of ticks) out.push(...engine.push(tick));
  out.push(...engine.flush());
  return out;
}
