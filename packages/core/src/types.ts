/*
  Canonical domain types. The engine's contract in one file: a feed hands us
  raw prints, normalization turns them into self-contained OptionTradeTicks
  (everything the engine needs rides on the tick — NBBO at print time, spot,
  OI — which is what makes replay byte-exact), and the engine emits FlowEvents
  whose whale score always ships with its full component breakdown.
*/

export type Right = "C" | "P";

export type Side = "buy" | "sell" | "mid" | "unknown";

export type EventKind = "sweep" | "block" | "split" | "print";

export type FeedId = "thetadata" | "massive" | "alpaca" | "tradier" | "replay" | "synthetic";

/** A parsed OCC option symbol, e.g. NVDA260918C00120000. */
export interface OptionContract {
  /** Canonical unpadded OCC symbol (root + yymmdd + right + strike*1000). */
  occ: string;
  underlying: string;
  /** ISO date, e.g. "2026-09-18". */
  expiry: string;
  strike: number;
  right: Right;
}

/** National best bid/offer at a moment in time. */
export interface Nbbo {
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  /** Feed timestamp of the quote (epoch ms). Staleness vs the print matters. */
  ts: number;
}

/**
 * Vendor-agnostic sale-condition vocabulary. Every feed adapter maps its own
 * condition codes onto these; the policy table in conditions.ts decides what
 * each one is allowed to do (score, join sweeps, count volume, ...).
 */
export type NormalizedCondition =
  | "regular"
  | "iso" // intermarket sweep order — corroborates sweep classification
  | "auto" // automatic electronic execution
  | "spread-leg" // leg of a multi-leg strategy — the classic false-positive source
  | "spread-leg-equity" // multi-leg trade with an equity leg
  | "auction" // opening/closing/other auction
  | "cross" // negotiated cross — not aggressive flow
  | "floor" // floor trade, typically reported with a delay
  | "cancel" // cancellation of a previous print
  | "late" // late report — timestamp unreliable
  | "out-of-sequence" // out-of-sequence report — timestamp unreliable
  | "reopening"
  | "unknown"; // unmapped vendor code — kept eligible but flagged in reasons

/**
 * One normalized, fully-enriched option trade print. Self-contained by
 * design: the flight recorder persists these verbatim and replay feeds them
 * back through the engine with zero external lookups.
 */
export interface OptionTradeTick {
  /** Monotonic ingest sequence within a run/tape — the deterministic tiebreaker. */
  seq: number;
  /** Feed timestamp of the print (epoch ms). */
  ts: number;
  underlying: string;
  /** Canonical unpadded OCC symbol. */
  contract: string;
  expiry: string;
  strike: number;
  right: Right;
  price: number;
  size: number;
  /** OPRA exchange id as reported by the feed (single letter where known). */
  exchange: string;
  conditions: NormalizedCondition[];
  /** NBBO captured at (or nearest to) print time; null when the feed has none. */
  nbbo: Nbbo | null;
  /** Underlying spot at ingest time; null when unavailable. */
  spot: number | null;
  /** Contract open interest as of the latest chain snapshot; null when unavailable. */
  oi: number | null;
  feedId: FeedId;
}

/** Names of the whale-score components. Transparency is the product. */
export type ScoreComponentName =
  | "volumeVsBaseline"
  | "premiumVsBaseline"
  | "volOi"
  | "aggression"
  | "urgency"
  | "repetition";

export interface ScoreComponent {
  /** Normalized 0..1 contribution; null when inputs were unavailable. */
  value: number | null;
  /** Configured weight for this component. */
  weight: number;
  /** value × weight after renormalization; null when value is null. */
  weighted: number | null;
  /** The raw inputs behind the normalized value — always shown, never hidden. */
  raw: Record<string, number | string | null>;
  note?: string;
}

/**
 * The whale score. Weighted sum of transparent components, scaled 0..100.
 * Components with missing inputs are excluded and the remaining weights are
 * renormalized; `missing` lists what was unavailable and `coldStart` flags
 * events scored before baselines have enough history to be trustworthy.
 */
export interface WhaleScore {
  total: number;
  components: Record<ScoreComponentName, ScoreComponent>;
  missing: ScoreComponentName[];
  /** Days of baseline history behind this contract's baselines. */
  baselineDays: number;
  coldStart: boolean;
}

/** A classified, scored flow event — the engine's output unit. */
export interface FlowEvent {
  /** Deterministic content hash — identical tape + config ⇒ identical ids. */
  id: string;
  /** Resolution timestamp: last leg's print time (epoch ms). */
  ts: number;
  /** US-equity session date (America/New_York calendar date), e.g. "2026-08-24". */
  sessionDate: string;
  kind: EventKind;
  /** Aggressor side of the flow. */
  side: Side;
  underlying: string;
  contract: string;
  expiry: string;
  strike: number;
  right: Right;
  /** The prints behind this event (1 for print/block, 2+ for sweep/split). */
  legs: OptionTradeTick[];
  legCount: number;
  /** Σ price × size × 100 across legs. */
  premium: number;
  /** Σ size across legs. */
  size: number;
  /** Premium-weighted average price. */
  price: number;
  /** Calendar days to expiry at event time (fractional). */
  dte: number;
  /** (strike−spot)/spot for calls, (spot−strike)/spot for puts; negative = ITM. */
  otmPct: number | null;
  spot: number | null;
  /** Contract day volume / open interest at event time. */
  volOiRatio: number | null;
  oi: number | null;
  exchanges: string[];
  score: WhaleScore;
  /** Human-readable classification trail — the flight-recorder story. */
  reasons: string[];
  feedId: FeedId;
  /** Ingest sequence of the first leg — the stable ordering key. */
  seq: number;
}

/** One contract row in a chain snapshot. */
export interface ChainContract {
  contract: string;
  underlying: string;
  expiry: string;
  strike: number;
  right: Right;
  oi: number | null;
  volume?: number | null;
  /** Implied vol if the feed provides it (decimal, e.g. 0.42). */
  iv?: number | null;
  greeks?: {
    delta?: number | null;
    gamma?: number | null;
    theta?: number | null;
    vega?: number | null;
  } | null;
  nbbo?: Nbbo | null;
}

export interface ChainSnapshot {
  underlying: string;
  ts: number;
  spot: number | null;
  contracts: ChainContract[];
}

/** Per-strike gamma-exposure ladder plus the interpolated zero-gamma level. */
export interface GexLadder {
  underlying: string;
  ts: number;
  spot: number;
  /** Which sign convention produced these numbers — always stated in output. */
  convention: string;
  conventionNote: string;
  expiriesIncluded: string[];
  perStrike: Array<{
    strike: number;
    callGex: number;
    putGex: number;
    netGex: number;
    callOi: number;
    putOi: number;
  }>;
  totalGex: number;
  zeroGamma: { level: number; method: string } | null;
  /** Contracts skipped because no gamma could be derived (no greeks, unsolvable IV). */
  skippedContracts: number;
}

/** A fired alert, persisted so any alert can be traced back to its event. */
export interface FiredAlert {
  id: string;
  ruleId: string;
  eventId: string;
  ts: number;
  sink: string;
  ok: boolean;
  detail?: string;
}

export interface EngineStats {
  ticksSeen: number;
  ticksCounted: number;
  eventsEmitted: number;
  eventsSuppressed: number;
  cancelsApplied: number;
  sweepsResolved: number;
  openWindows: number;
  sessionDate: string | null;
}
