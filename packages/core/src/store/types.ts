/*
  The flight recorder contract. Every print's full story is persisted — the
  raw tick with the NBBO used at print time, the classified event with its
  score breakdown and reasons, the baselines that informed it, and every
  fired alert pointing back to its event id. `whale replay` re-runs any
  window of the tape through the current config.
*/
import type { AlertRule } from "../config.js";
import type { BaselineDayRows, BaselineState } from "../score/baselines.js";
import type {
  ChainSnapshot,
  EngineStats,
  EventKind,
  FiredAlert,
  FlowEvent,
  OptionTradeTick,
  Side,
} from "../types.js";

export interface EventFilter {
  underlying?: string;
  contract?: string;
  kind?: EventKind;
  side?: Side;
  minPremium?: number;
  minScore?: number;
  excludeColdStart?: boolean;
  from?: number;
  to?: number;
  limit?: number;
  /** "ts" (default, newest first) or "score" (highest first). */
  orderBy?: "ts" | "score";
}

export interface TickFilter {
  from?: number;
  to?: number;
  underlying?: string;
  contract?: string;
}

export interface StoredRule {
  rule: AlertRule;
  source: "config" | "dynamic";
  createdTs: number;
  updatedTs: number;
}

/** One contract's end-of-session state — the substrate for OI deltas and IV history. */
export interface ContractDailyRow {
  contract: string;
  sessionDate: string;
  underlying: string;
  expiry: string;
  strike: number;
  right: "C" | "P";
  oi: number | null;
  iv: number | null;
  /** Quote mid at snapshot time, when the chain carried one. */
  mid: number | null;
  volume: number | null;
}

/** One underlying's end-of-session state — spot closes and ATM IV history. */
export interface UnderlyingDailyRow {
  underlying: string;
  sessionDate: string;
  spotClose: number | null;
  /** IV of the nearest-the-money near-dated contracts (C/P averaged). */
  atmIv: number | null;
}

/** FINRA daily short-sale volume — end-of-day context, never real-time. */
export interface ShortVolumeRow {
  symbol: string;
  sessionDate: string;
  shortVolume: number;
  shortExemptVolume: number;
  totalVolume: number;
  source: string;
}

/** Session-level net premium aggregates per underlying, from emitted events. */
export interface NetFlowRow {
  underlying: string;
  events: number;
  callBuyPremium: number;
  callSellPremium: number;
  putBuyPremium: number;
  putSellPremium: number;
  /** (call buys − call sells) − (put buys − put sells): bullish-positive. */
  netPremium: number;
}

export interface StoreStatus {
  ticks: number;
  events: number;
  rules: number;
  alertsFired: number;
  firstTickTs: number | null;
  lastTickTs: number | null;
  lastEventTs: number | null;
  baselineSessions: string[];
  dbSizeBytes: number | null;
  /** Last engine heartbeat; a live `whale run` refreshes this every few seconds. */
  heartbeatTs: number | null;
  engineStats: EngineStats | null;
}

export interface FlightRecorder {
  insertTicks(ticks: OptionTradeTick[]): void;
  insertEvents(events: FlowEvent[]): void;
  getEvent(id: string): FlowEvent | null;
  queryEvents(filter: EventFilter): FlowEvent[];
  /** Ordered iteration for replay — ascending (seq) within [from, to]. */
  iterateTicks(filter: TickFilter): Iterable<OptionTradeTick>;
  countTicks(filter: TickFilter): number;
  /** Highest persisted tick seq — live runs continue numbering from here. */
  maxTickSeq(): number | null;

  saveBaselineDay(rows: BaselineDayRows): void;
  /** Hydrate prior-day baselines, optionally only sessions before a date. */
  loadBaselineState(lookbackDays: number, beforeDate?: string): BaselineState;
  baselineSessionDates(): string[];

  upsertChainSnapshot(snapshot: ChainSnapshot): void;
  getChainSnapshot(underlying: string): ChainSnapshot | null;
  listChainSnapshots(): Array<{ underlying: string; ts: number }>;

  /** Daily history (OI/IV per contract, spot/ATM-IV per underlying). */
  upsertContractDaily(rows: ContractDailyRow[]): void;
  getContractDaily(contract: string, days?: number): ContractDailyRow[];
  getContractDailyByUnderlying(underlying: string, sessionDate: string): ContractDailyRow[];
  contractDailySessionDates(underlying?: string): string[];
  upsertUnderlyingDaily(rows: UnderlyingDailyRow[]): void;
  getUnderlyingDaily(underlying: string, days?: number): UnderlyingDailyRow[];

  /** FINRA daily short-sale volume cache (EOD context, never real-time). */
  upsertShortVolume(rows: ShortVolumeRow[]): void;
  getShortVolume(symbol: string, days?: number): ShortVolumeRow[];

  /** Net premium per underlying over a window, aggregated from emitted events. */
  netFlow(from: number, to: number): NetFlowRow[];

  listRules(): StoredRule[];
  upsertRule(rule: AlertRule, source: "config" | "dynamic"): void;
  removeRule(id: string): boolean;

  insertAlertFired(alert: FiredAlert): void;
  listAlertsFired(limit?: number, ruleId?: string): FiredAlert[];

  heartbeat(stats: EngineStats): void;
  status(): StoreStatus;
  prune(
    ticksRetentionDays: number,
    eventsRetentionDays: number,
    nowTs: number,
  ): {
    ticksDeleted: number;
    eventsDeleted: number;
  };
  close(): void;
}
