/*
  Local mirrors of the engine's API payloads. The dashboard talks HTTP/WS
  only — it deliberately does not import from @luxalgo/whale-core, so these
  shapes are redeclared here and must track the JSON the server returns
  (core/src/types.ts is the source of truth).
*/

export type Right = "C" | "P";

export type Side = "buy" | "sell" | "mid" | "unknown";

export type EventKind = "sweep" | "block" | "split" | "print";

export interface Nbbo {
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  ts: number;
}

/** One print behind an event (OptionTradeTick in the engine). */
export interface EventLeg {
  seq: number;
  ts: number;
  underlying: string;
  contract: string;
  expiry: string;
  strike: number;
  right: Right;
  price: number;
  size: number;
  exchange: string;
  conditions: string[];
  nbbo: Nbbo | null;
  spot: number | null;
  oi: number | null;
  feedId: string;
}

export type ScoreComponentName =
  | "volumeVsBaseline"
  | "premiumVsBaseline"
  | "volOi"
  | "aggression"
  | "urgency"
  | "repetition";

export interface ScoreComponent {
  value: number | null;
  weight: number;
  /** Points contributed to the 0..100 total; null when value is null. */
  weighted: number | null;
  raw: Record<string, number | string | null>;
  note?: string;
}

export interface WhaleScore {
  total: number;
  components: Record<ScoreComponentName, ScoreComponent>;
  missing: ScoreComponentName[];
  baselineDays: number;
  coldStart: boolean;
}

export interface FlowEvent {
  id: string;
  ts: number;
  sessionDate: string;
  kind: EventKind;
  side: Side;
  underlying: string;
  contract: string;
  expiry: string;
  strike: number;
  right: Right;
  legs: EventLeg[];
  legCount: number;
  premium: number;
  size: number;
  price: number;
  dte: number;
  otmPct: number | null;
  spot: number | null;
  volOiRatio: number | null;
  oi: number | null;
  exchanges: string[];
  score: WhaleScore;
  reasons: string[];
  feedId: string;
  seq: number;
}

export interface GexLadder {
  underlying: string;
  ts: number;
  spot: number;
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
  skippedContracts: number;
}

/** GET /api/market/netflow — net premium leaderboard over a window. */
export interface NetFlowRow {
  underlying: string;
  events: number;
  callBuyPremium: number;
  callSellPremium: number;
  putBuyPremium: number;
  putSellPremium: number;
  netPremium: number;
  callNet: number;
  putNet: number;
}

export interface NetFlowTotals {
  underlyings: number;
  events: number;
  callBuyPremium: number;
  callSellPremium: number;
  putBuyPremium: number;
  putSellPremium: number;
  callNet: number;
  putNet: number;
  netPremium: number;
}

export interface NetFlowReport {
  from: number;
  to: number;
  rows: NetFlowRow[];
  totals: NetFlowTotals;
  note: string;
}

/** GET /api/market/oi/:underlying — session-to-session OI deltas. */
export interface OiDeltaContract {
  contract: string;
  expiry: string;
  strike: number;
  right: Right;
  prevOi: number | null;
  currOi: number;
  deltaOi: number;
  deltaPct: number | null;
  newContract: boolean;
}

export interface OiDeltaGroup {
  prevOi: number;
  currOi: number;
  deltaOi: number;
}

export interface OiDeltasResult {
  underlying: string;
  fromDate: string | null;
  toDate: string | null;
  sessionsAvailable: number;
  contracts: OiDeltaContract[];
  byStrike: Array<{ strike: number } & OiDeltaGroup>;
  byExpiry: Array<{ expiry: string } & OiDeltaGroup>;
  /** Honest caveat when history is insufficient; null otherwise. */
  note: string | null;
}

/** GET /api/market/maxpain/:underlying — per-expiry max-pain statics. */
export interface MaxPainExpiry {
  expiry: string;
  maxPainStrike: number;
  totalPayoutAtStrike: number;
  callOi: number;
  putOi: number;
  strikesEvaluated: number;
  spot: number | null;
  note: string;
}

export interface MaxPainResult {
  underlying: string;
  source: "chain-snapshot" | "contract-daily" | null;
  asOfTs: number | null;
  sessionDate: string | null;
  spot: number | null;
  expiries: MaxPainExpiry[];
  note: string;
}

/** GET /api/market/ivrank/:underlying — IV rank over recorded history. */
export interface IvRankResult {
  underlying: string;
  currentIv: number | null;
  minIv: number | null;
  maxIv: number | null;
  ivRank: number | null;
  ivPercentile: number | null;
  historyDays: number;
  firstDate: string | null;
  lastDate: string | null;
  note: string;
}

/** GET /api/audit — outcome calibration of recorded whale scores. */
export interface CalibrationBucket {
  label: string;
  n: number;
  medianFwdReturnPct: number | null;
  meanFwdReturnPct: number | null;
  alignedPct: number | null;
  /** n < 30 — the row is noise, not signal; render it dimmed and say so. */
  smallN: boolean;
}

export interface CalibrationReport {
  window: { from: number; to: number };
  horizon: string;
  eventsConsidered: number;
  eventsWithOutcome: number;
  excluded: { mid: number; unknown: number; noPriceData: number };
  buckets: CalibrationBucket[];
  byKind: CalibrationBucket[];
  bySide: CalibrationBucket[];
  baseRate: { alignedPct: number | null; medianFwdReturnPct: number | null };
  /** Always populated by the engine — the UI must render every one. */
  caveats: string[];
}

/** GET /api/context/short-volume/:symbol — FINRA EOD cache, never live. */
export interface ShortVolumeDay {
  sessionDate: string;
  shortVolume: number;
  shortExemptVolume: number;
  totalVolume: number;
  shortRatio: number | null;
}

export interface ShortVolumeReport {
  symbol: string;
  days: ShortVolumeDay[];
  avgShortRatio: number | null;
  note: string;
}

/** GET /api/status — store status plus the extras `whale run` attaches. */
export interface EngineStatus {
  ticks: number;
  events: number;
  rules: number;
  alertsFired: number;
  firstTickTs: number | null;
  lastTickTs: number | null;
  lastEventTs: number | null;
  baselineSessions: string[];
  dbSizeBytes: number | null;
  heartbeatTs: number | null;
  engineStats: Record<string, unknown> | null;
  chains_available?: string[];
  feed?: string;
  universe?: string[];
  configPath?: string | null;
}
