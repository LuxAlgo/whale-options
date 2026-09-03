/*
  The feed adapter contract: one interface, many vendors. Adapters own all
  vendor I/O and quirks; they surface raw prints with whatever enrichment the
  vendor already provides (NBBO, spot, OI) and expose lookups for the rest.
  The runner attaches missing enrichment before the pure engine ever sees a
  tick, so the engine stays deterministic and replayable.
*/
import type { ChainSnapshot, FeedId, Nbbo, NormalizedCondition } from "../types.js";

export interface FeedCapabilities {
  realtime: boolean;
  /** Vendor supplies greeks/IV on chain snapshots. */
  greeksProvided: boolean;
  /** Vendor supplies NBBO alongside trades (vs needing a quote lookup). */
  nbbo: boolean;
  /** Vendor supplies sale-condition codes. */
  conditions: boolean;
}

/**
 * A raw option print as the adapter delivers it. `contract` must already be
 * an OCC/OSI-parsable symbol; `conditions` carries vendor codes verbatim —
 * normalization maps them via the adapter's condition table.
 */
export interface RawOptionTrade {
  ts: number;
  contract: string;
  price: number;
  size: number;
  exchange: string;
  /** Vendor-encoded sale conditions (strings or numeric codes as strings). */
  conditions: string[];
  nbbo?: Nbbo | null;
  spot?: number | null;
  oi?: number | null;
}

/** Equity bar resolutions an adapter may serve for the underlying. */
export type BarTimeframe = "1m" | "5m" | "15m" | "1h" | "1d";

export interface BarRange {
  /** Inclusive start, epoch ms. */
  from: number;
  /** Inclusive end, epoch ms. */
  to: number;
}

/** One underlying (stock/ETF) bar; `ts` is the bar's open time in epoch ms. */
export interface UnderlyingBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Share volume; null when the source has none (the synthetic walk, for one). */
  volume: number | null;
}

/** Bars plus, in words, where they came from — surfaced verbatim in API payloads. */
export interface UnderlyingBarsResult {
  bars: UnderlyingBar[];
  /** Short source label, e.g. "alpaca stock bars (feed=iex)". */
  source: string;
  /** What the bars are and are not (entitlement tier, adjustment, session coverage). */
  note: string;
}

export interface TradeFilter {
  /** Per-underlying subscription filter — full-firehose days are heavy and
   *  the engine never assumes it sees the whole market. */
  underlyings?: string[];
}

export interface FeedAdapter {
  readonly id: FeedId;
  capabilities(): FeedCapabilities;
  /**
   * Live (or replayed) stream of option trades. The iterable ends when the
   * feed closes or the signal aborts.
   */
  subscribeOptionTrades(filter: TradeFilter, signal?: AbortSignal): AsyncIterable<RawOptionTrade>;
  /** Latest NBBO for a contract; null when unavailable. */
  getNbbo(contract: string): Promise<Nbbo | null>;
  /** Chain snapshot (strikes, OI, greeks/IV when provided) for GEX + vol/OI. */
  getChainSnapshot(underlying: string): Promise<ChainSnapshot | null>;
  /** Best-effort underlying spot; null when the vendor has no equity data. */
  getSpot?(underlying: string): Promise<number | null>;
  /** Map one vendor condition code to the normalized vocabulary. */
  normalizeCondition(code: string): NormalizedCondition;
  /**
   * Historical option trades for one session date (ISO, e.g. "2026-08-21"),
   * in time order — powers `whale backfill`. Optional: only vendors with a
   * historical entitlement implement it, and only for the user's own account.
   */
  getHistoricalOptionTrades?(
    underlying: string,
    dateIso: string,
    signal?: AbortSignal,
  ): AsyncIterable<RawOptionTrade>;
  /** End-of-session chain snapshot (OI/IV as of that date) for backfill. */
  getHistoricalChain?(underlying: string, dateIso: string): Promise<ChainSnapshot | null>;
  /**
   * Bars of the UNDERLYING (stock/ETF) at a timeframe over an inclusive
   * range, for the chart's price pane. Optional: only vendors with an equity
   * bar endpoint implement it (and only within the user's own entitlement);
   * the API falls back to the spot tape built from option prints and says
   * so. Return null (or an empty `bars`) when the range cannot be served —
   * never a fabricated series.
   */
  getUnderlyingBars?(
    symbol: string,
    timeframe: BarTimeframe,
    range: BarRange,
  ): Promise<UnderlyingBarsResult | null>;
  close?(): Promise<void>;
}
