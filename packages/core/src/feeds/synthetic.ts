/*
  Synthetic feed — the default demo and the test substrate.

  Recorded real OPRA data cannot be redistributed, so the repo's demo tape is
  generated: statistically-plausible background flow with injected motifs
  (multi-exchange sweeps, blocks, minutes-long ladders, spread legs that must
  NOT flag, cancels) over GBM underlyings with a vol smile. Everything is
  seeded — same seed, same tape, byte for byte — which is also what the
  golden tests are built on.
*/
import { blackScholes } from "../greeks/black-scholes.js";
import { formatOcc } from "../occ.js";
import type { ChainContract, ChainSnapshot, Nbbo, NormalizedCondition, Right } from "../types.js";
import {
  mulberry32,
  pick,
  pickWeighted,
  type Rng,
  randExp,
  randInt,
  randLogNormal,
  randNormal,
} from "../util/prng.js";
import { easternTimeToUtc, sessionDateOf } from "../util/session.js";
import type { FeedAdapter, FeedCapabilities, RawOptionTrade, TradeFilter } from "./types.js";

export interface SyntheticUnderlying {
  symbol: string;
  spot: number;
  /** Annualized base volatility (decimal). */
  vol: number;
  /** Relative liquidity weight (contract OI and print intensity). */
  liquidity: number;
}

export interface SyntheticOptions {
  seed?: number;
  regime?: "mixed" | "quiet" | "sweep-clusters" | "earnings-ramp";
  eventsPerMinute?: number;
  underlyings?: SyntheticUnderlying[];
  /** First print timestamp; defaults to 09:30 ET today (pass one for fixtures). */
  startTs?: number;
  /** Stop after this many prints (fixtures); omit for an endless live demo. */
  maxEvents?: number;
  /** "realtime" paces prints against the wall clock; "asap" streams flat out. */
  pace?: "realtime" | "asap";
}

export const DEFAULT_UNDERLYINGS: SyntheticUnderlying[] = [
  { symbol: "NVDA", spot: 190, vol: 0.45, liquidity: 1.0 },
  { symbol: "SPY", spot: 645, vol: 0.13, liquidity: 1.2 },
  { symbol: "TSLA", spot: 340, vol: 0.55, liquidity: 0.9 },
  { symbol: "AAPL", spot: 232, vol: 0.25, liquidity: 0.8 },
  { symbol: "AMD", spot: 165, vol: 0.5, liquidity: 0.6 },
];

const EXCHANGE_IDS = ["C", "N", "Q", "X", "B", "M", "A", "W", "H", "Z"] as const;
const RISK_FREE = 0.05;
const YEAR_MS = 365 * 86_400_000;

interface SynthContract {
  occ: string;
  underlying: string;
  expiry: string;
  expiryTs: number;
  strike: number;
  right: Right;
  oi: number;
  iv: number;
}

interface UnderlyingState {
  def: SyntheticUnderlying;
  spot: number;
  lastMoveTs: number;
  contracts: SynthContract[];
  /** Cumulative OI-based pick weights, biased toward near-ATM short-dated. */
  weights: number[];
}

interface ScheduledPrint {
  ts: number;
  trade: RawOptionTrade;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Next `count` weekly Fridays plus the next two third-Fridays, deduped. */
function buildExpiries(startTs: number, weeklies = 4): string[] {
  const out = new Set<string>();
  const start = new Date(startTs);
  const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  // Weekly Fridays strictly after the start date.
  let cursor = new Date(d);
  while (out.size < weeklies) {
    cursor = new Date(cursor.getTime() + 86_400_000);
    if (cursor.getUTCDay() === 5) out.add(cursor.toISOString().slice(0, 10));
  }
  // Third Fridays of this and next month.
  for (let k = 0; k < 2; k++) {
    const month = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, 1));
    let fridays = 0;
    for (let day = 1; day <= 31; day++) {
      const t = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), day));
      if (t.getUTCMonth() !== month.getUTCMonth()) break;
      if (t.getUTCDay() === 5) {
        fridays++;
        if (fridays === 3) {
          if (t.getTime() > d.getTime()) out.add(t.toISOString().slice(0, 10));
          break;
        }
      }
    }
  }
  return [...out].sort();
}

function strikeStep(spot: number): number {
  if (spot < 50) return 1;
  if (spot < 200) return 2.5;
  return 5;
}

export class SyntheticFeed implements FeedAdapter {
  readonly id = "synthetic" as const;
  private readonly rng: Rng;
  private readonly opts: Required<
    Pick<SyntheticOptions, "seed" | "regime" | "eventsPerMinute" | "pace">
  > &
    SyntheticOptions;
  private readonly startTs: number;
  private readonly universe = new Map<string, UnderlyingState>();
  private readonly rampTarget: string;
  private currentTs: number;

  constructor(options: SyntheticOptions = {}) {
    const seed = options.seed ?? 42;
    this.rng = mulberry32(seed);
    this.opts = {
      seed,
      regime: options.regime ?? "mixed",
      eventsPerMinute: options.eventsPerMinute ?? 120,
      pace: options.pace ?? "realtime",
      ...options,
    };
    this.startTs = options.startTs ?? easternTimeToUtc(sessionDateOf(Date.now()), 9, 30);
    this.currentTs = this.startTs;
    const defs = options.underlyings?.length ? options.underlyings : DEFAULT_UNDERLYINGS;
    for (const def of defs) this.universe.set(def.symbol, this.buildUnderlying(def));
    this.rampTarget = pick(this.rng, [...this.universe.keys()]);
  }

  capabilities(): FeedCapabilities {
    return { realtime: true, greeksProvided: true, nbbo: true, conditions: true };
  }

  normalizeCondition(code: string): NormalizedCondition {
    const known: NormalizedCondition[] = [
      "regular",
      "iso",
      "auto",
      "spread-leg",
      "spread-leg-equity",
      "auction",
      "cross",
      "floor",
      "cancel",
      "late",
      "out-of-sequence",
      "reopening",
    ];
    return (known as string[]).includes(code) ? (code as NormalizedCondition) : "unknown";
  }

  private buildUnderlying(def: SyntheticUnderlying): UnderlyingState {
    const expiries = buildExpiries(this.startTs);
    const step = strikeStep(def.spot);
    const contracts: SynthContract[] = [];
    for (const expiry of expiries) {
      const expiryTs = easternTimeToUtc(expiry, 16);
      const lo = Math.ceil((def.spot * 0.75) / step) * step;
      const hi = Math.floor((def.spot * 1.25) / step) * step;
      for (let strike = lo; strike <= hi; strike += step) {
        for (const right of ["C", "P"] as Right[]) {
          const m = Math.log(strike / def.spot);
          const iv = def.vol * (1 + 1.5 * m * m) + 0.04 * Math.max(0, -m);
          const distanceDecay = Math.exp(-6 * Math.abs(m));
          const roundBoost = strike % 10 === 0 ? 1.5 : 1;
          const oi = Math.max(
            0,
            Math.round(
              randLogNormal(this.rng, Math.log(400 * def.liquidity), 0.9) *
                distanceDecay *
                roundBoost,
            ),
          );
          contracts.push({
            occ: formatOcc(def.symbol, expiry, right, strike),
            underlying: def.symbol,
            expiry,
            expiryTs,
            strike,
            right,
            oi,
            iv,
          });
        }
      }
    }
    // Pick weights: OI × recency-of-expiry bias, so flow clusters where real flow does.
    const weights = contracts.map((c) => {
      const dteDays = Math.max(0.5, (c.expiryTs - this.startTs) / 86_400_000);
      return (c.oi + 1) * (1 / Math.sqrt(dteDays));
    });
    return { def, spot: def.spot, lastMoveTs: this.startTs, contracts, weights };
  }

  private advanceSpot(u: UnderlyingState, ts: number): void {
    const dtMs = ts - u.lastMoveTs;
    if (dtMs <= 0) return;
    const dt = dtMs / YEAR_MS;
    const vol =
      u.def.vol *
      (this.opts.regime === "earnings-ramp" && u.def.symbol === this.rampTarget ? 1.6 : 1);
    u.spot *= Math.exp(-0.5 * vol * vol * dt + vol * Math.sqrt(dt) * randNormal(this.rng));
    u.lastMoveTs = ts;
  }

  private nbboFor(u: UnderlyingState, c: SynthContract, ts: number): Nbbo {
    const tau = Math.max(1e-6, (c.expiryTs - ts) / YEAR_MS);
    const fair = blackScholes({
      spot: u.spot,
      strike: c.strike,
      tau,
      iv: c.iv,
      r: RISK_FREE,
      q: 0,
      right: c.right,
    }).price;
    const spread = Math.max(0.01, fair * (0.015 + 0.05 / Math.sqrt(c.oi + 10)));
    const half = spread / 2;
    const bid = Math.max(0, Math.round((fair - half) * 100) / 100);
    const ask = Math.max(bid + 0.01, Math.round((fair + half) * 100) / 100);
    return {
      bid,
      ask,
      bidSize: randInt(this.rng, 5, 200),
      askSize: randInt(this.rng, 5, 200),
      ts: ts - randInt(this.rng, 5, 400),
    };
  }

  private pickContract(u: UnderlyingState): SynthContract {
    const i = pickWeighted(this.rng, u.weights);
    const c = u.contracts[i];
    if (!c) throw new Error("empty synthetic chain");
    return c;
  }

  private pickUnderlying(filter: TradeFilter): UnderlyingState {
    const symbols = [...this.universe.keys()].filter(
      (s) => !filter.underlyings?.length || filter.underlyings.includes(s),
    );
    const states = symbols
      .map((s) => this.universe.get(s))
      .filter((s): s is UnderlyingState => Boolean(s));
    if (states.length === 0) throw new Error("no underlyings match the filter");
    const weights = states.map((s) => {
      const ramp = this.opts.regime === "earnings-ramp" && s.def.symbol === this.rampTarget ? 3 : 1;
      return s.def.liquidity * ramp;
    });
    const state = states[pickWeighted(this.rng, weights)];
    if (!state) throw new Error("unreachable");
    return state;
  }

  private makeTrade(
    u: UnderlyingState,
    c: SynthContract,
    ts: number,
    side: "buy" | "sell" | "mid",
    size: number,
    conditions: string[],
    exchange?: string,
    through = false,
  ): RawOptionTrade {
    this.advanceSpot(u, ts);
    const nbbo = this.nbboFor(u, c, ts);
    let price: number;
    if (side === "buy") price = through ? Math.round((nbbo.ask + 0.01) * 100) / 100 : nbbo.ask;
    else if (side === "sell")
      price = through ? Math.max(0.01, Math.round((nbbo.bid - 0.01) * 100) / 100) : nbbo.bid;
    else price = Math.round(((nbbo.bid + nbbo.ask) / 2) * 100) / 100;
    return {
      ts,
      contract: c.occ,
      price: Math.max(0.01, price),
      size,
      exchange: exchange ?? pick(this.rng, EXCHANGE_IDS),
      conditions,
      nbbo,
      spot: Math.round(u.spot * 100) / 100,
      oi: c.oi,
    };
  }

  /** Motif rates per hour for the active regime. */
  private motifRates(): { sweep: number; block: number; ladder: number; spread: number } {
    switch (this.opts.regime) {
      case "quiet":
        return { sweep: 30, block: 20, ladder: 6, spread: 40 };
      case "sweep-clusters":
        return { sweep: 900, block: 60, ladder: 15, spread: 60 };
      case "earnings-ramp":
        return { sweep: 400, block: 150, ladder: 30, spread: 60 };
      default:
        return { sweep: 300, block: 120, ladder: 20, spread: 90 };
    }
  }

  async *subscribeOptionTrades(
    filter: TradeFilter,
    signal?: AbortSignal,
  ): AsyncIterable<RawOptionTrade> {
    const rates = this.motifRates();
    const meanGapMs = 60_000 / this.opts.eventsPerMinute;
    const pending: ScheduledPrint[] = []; // min-heap-lite: kept sorted on insert
    const wallStart = Date.now();
    let emitted = 0;

    const schedule = (p: ScheduledPrint) => {
      let i = pending.length;
      while (i > 0 && (pending[i - 1]?.ts ?? 0) > p.ts) i--;
      pending.splice(i, 0, p);
    };

    const scheduleMotifs = (now: number, dtMs: number) => {
      const hours = dtMs / 3_600_000;
      if (this.rng() < rates.sweep * hours) this.scheduleSweep(filter, now, schedule);
      if (this.rng() < rates.block * hours) this.scheduleBlock(filter, now, schedule);
      if (this.rng() < rates.ladder * hours) this.scheduleLadder(filter, now, schedule);
      if (this.rng() < rates.spread * hours) this.scheduleSpread(filter, now, schedule);
    };

    while (!signal?.aborted) {
      if (this.opts.maxEvents !== undefined && emitted >= this.opts.maxEvents) return;

      const gap = randExp(this.rng, meanGapMs);
      const nextBackgroundTs = this.currentTs + gap;
      const nextPending = pending[0];

      let trade: RawOptionTrade;
      if (nextPending && nextPending.ts <= nextBackgroundTs) {
        pending.shift();
        this.currentTs = Math.max(this.currentTs, nextPending.ts);
        trade = nextPending.trade;
      } else {
        this.currentTs = nextBackgroundTs;
        scheduleMotifs(this.currentTs, gap);
        const u = this.pickUnderlying(filter);
        const c = this.pickContract(u);
        const sideRoll = this.rng();
        const buyBias =
          this.opts.regime === "earnings-ramp" && u.def.symbol === this.rampTarget ? 0.55 : 0.4;
        const side = sideRoll < buyBias ? "buy" : sideRoll < buyBias * 2 ? "sell" : "mid";
        const size = Math.max(1, Math.round(randLogNormal(this.rng, Math.log(8), 1.0)));
        trade = this.makeTrade(u, c, this.currentTs, side, size, ["regular"]);
        // Rare cancel of this very print, arriving shortly after.
        if (this.rng() < 0.004) {
          schedule({
            ts: this.currentTs + randInt(this.rng, 200, 800),
            trade: {
              ...trade,
              ts: this.currentTs + randInt(this.rng, 200, 800),
              conditions: ["cancel"],
            },
          });
        }
      }

      if (this.opts.pace === "realtime") {
        const targetWall = wallStart + (trade.ts - this.startTs);
        const waitMs = targetWall - Date.now();
        if (waitMs > 5) await sleep(Math.min(waitMs, 5_000), signal);
        if (signal?.aborted) return;
      }

      emitted++;
      yield trade;
    }
  }

  private scheduleSweep(
    filter: TradeFilter,
    now: number,
    schedule: (p: ScheduledPrint) => void,
  ): void {
    const u = this.pickUnderlying(filter);
    // Sweeps hit liquid near-ATM short-dated contracts.
    const liquid = [...u.contracts].sort((a, b) => b.oi - a.oi).slice(0, 40);
    const c = pick(this.rng, liquid);
    const side = this.rng() < 0.62 ? "buy" : "sell";
    const legs = randInt(this.rng, 3, 6);
    const exchanges = [...EXCHANGE_IDS].sort(() => this.rng() - 0.5).slice(0, legs);
    let ts = now + randInt(this.rng, 10, 60);
    for (let i = 0; i < legs; i++) {
      const size = randInt(this.rng, 20, 300);
      const conditions = this.rng() < 0.7 ? ["iso"] : ["regular"];
      const through = i === legs - 1 && this.rng() < 0.4;
      schedule({
        ts,
        trade: this.makeTrade(
          u,
          c,
          ts,
          side,
          size,
          conditions,
          exchanges[i % exchanges.length],
          through,
        ),
      });
      ts += randInt(this.rng, 20, 120);
    }
  }

  private scheduleBlock(
    filter: TradeFilter,
    now: number,
    schedule: (p: ScheduledPrint) => void,
  ): void {
    const u = this.pickUnderlying(filter);
    const c = this.pickContract(u);
    const side = this.rng() < 0.5 ? "buy" : "sell";
    const size = randInt(this.rng, 300, 2500);
    const roll = this.rng();
    const conditions = roll < 0.15 ? ["late"] : roll < 0.25 ? ["floor"] : ["regular"];
    const ts = now + randInt(this.rng, 10, 200);
    schedule({ ts, trade: this.makeTrade(u, c, ts, side, size, conditions) });
  }

  private scheduleLadder(
    filter: TradeFilter,
    now: number,
    schedule: (p: ScheduledPrint) => void,
  ): void {
    const u = this.pickUnderlying(filter);
    const c = this.pickContract(u);
    const side = this.rng() < 0.6 ? "buy" : "sell";
    const clips = randInt(this.rng, 4, 7);
    const exchange = pick(this.rng, EXCHANGE_IDS);
    let ts = now + randInt(this.rng, 500, 2000);
    for (let i = 0; i < clips; i++) {
      const size = randInt(this.rng, 20, 90);
      schedule({ ts, trade: this.makeTrade(u, c, ts, side, size, ["regular"], exchange) });
      ts += randInt(this.rng, 45_000, 120_000);
    }
  }

  private scheduleSpread(
    filter: TradeFilter,
    now: number,
    schedule: (p: ScheduledPrint) => void,
  ): void {
    const u = this.pickUnderlying(filter);
    const c1 = this.pickContract(u);
    const sibling = u.contracts.filter(
      (c) => c.expiry === c1.expiry && c.right === c1.right && c.strike !== c1.strike,
    );
    if (sibling.length === 0) return;
    const c2 = pick(this.rng, sibling);
    const size = randInt(this.rng, 10, 200);
    const ts = now + randInt(this.rng, 10, 100);
    const exchange = pick(this.rng, EXCHANGE_IDS);
    // Both legs print at the same moment on the same venue — a vertical.
    schedule({ ts, trade: this.makeTrade(u, c1, ts, "mid", size, ["spread-leg"], exchange) });
    schedule({ ts, trade: this.makeTrade(u, c2, ts, "mid", size, ["spread-leg"], exchange) });
  }

  async getNbbo(contract: string): Promise<Nbbo | null> {
    for (const u of this.universe.values()) {
      const c = u.contracts.find((x) => x.occ === contract);
      if (c) return this.nbboFor(u, c, this.currentTs);
    }
    return null;
  }

  async getChainSnapshot(underlying: string): Promise<ChainSnapshot | null> {
    const u = this.universe.get(underlying.toUpperCase());
    if (!u) return null;
    this.advanceSpot(u, this.currentTs);
    const contracts: ChainContract[] = u.contracts.map((c) => ({
      contract: c.occ,
      underlying: c.underlying,
      expiry: c.expiry,
      strike: c.strike,
      right: c.right,
      oi: c.oi,
      iv: Math.round(c.iv * 1e4) / 1e4,
      nbbo: this.nbboFor(u, c, this.currentTs),
    }));
    return {
      underlying: u.def.symbol,
      ts: this.currentTs,
      spot: Math.round(u.spot * 100) / 100,
      contracts,
    };
  }

  async getSpot(underlying: string): Promise<number | null> {
    const u = this.universe.get(underlying.toUpperCase());
    if (!u) return null;
    this.advanceSpot(u, this.currentTs);
    return Math.round(u.spot * 100) / 100;
  }

  /**
   * Deterministic per-date sub-feed: (seed, date) fully determine a past
   * session, so `whale backfill --feed synthetic` is reproducible — the
   * demo path for warming baselines without any real data.
   */
  private historicalFeed(dateIso: string): SyntheticFeed {
    let h = (this.opts.seed >>> 0) ^ 0x811c9dc5;
    for (const ch of dateIso) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    return new SyntheticFeed({
      seed: h,
      regime: this.opts.regime,
      eventsPerMinute: this.opts.eventsPerMinute,
      underlyings: this.opts.underlyings,
      startTs: easternTimeToUtc(dateIso, 9, 30),
      maxEvents: 4000,
      pace: "asap",
    });
  }

  async *getHistoricalOptionTrades(
    underlying: string,
    dateIso: string,
    signal?: AbortSignal,
  ): AsyncIterable<RawOptionTrade> {
    const feed = this.historicalFeed(dateIso);
    yield* feed.subscribeOptionTrades({ underlyings: [underlying.toUpperCase()] }, signal);
  }

  async getHistoricalChain(underlying: string, dateIso: string): Promise<ChainSnapshot | null> {
    const feed = this.historicalFeed(dateIso);
    // Advance the sub-feed to that session's close so OI/IV/spot read as EOD.
    feed.currentTs = easternTimeToUtc(dateIso, 16, 0);
    return feed.getChainSnapshot(underlying);
  }
}
