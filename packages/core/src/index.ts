/*
  @luxalgo/whale-core — the open-source options-flow engine.
  Pure engine + adapters + flight recorder; the CLI, MCP server, and
  dashboard are thin layers over these exports.
*/

export { AlertDispatcher } from "./alerts/dispatcher.js";
// Alerts
export { ruleMatches } from "./alerts/match.js";
export { buildWebhookBody, createSink, type SinkFn, type SinkResult } from "./alerts/sinks.js";
export * from "./audit/index.js";
// Backfill — historical ingestion that warms baselines (whale backfill)
export * from "./backfill/index.js";
export { type AggressorResult, inferAggressor } from "./classify/aggressor.js";
export { type BlockThreshold, Classifier, type ProtoEvent } from "./classify/classifier.js";
export * from "./compare/index.js";
export {
  type ConditionPolicy,
  EXCHANGES,
  hasIso,
  isCancel,
  isSpreadLeg,
  policyFor,
} from "./conditions.js";
// Config
export {
  type AlertRule,
  alertRuleSchema,
  configSchema,
  defineConfig,
  feedIdSchema,
  resolveConfig,
  type WhaleConfig,
  type WhaleConfigInput,
} from "./config.js";
export * from "./context/index.js";
// Engine
export { Engine } from "./engine.js";
export { AlpacaFeed, type AlpacaOptions } from "./feeds/alpaca.js";
export { MassiveFeed, type MassiveOptions } from "./feeds/massive.js";
export { createFeed, type FeedFactory, registeredFeeds, registerFeed } from "./feeds/registry.js";
export { ReplayFeed, type TapeRow, TapeWriter } from "./feeds/replay.js";
export {
  DEFAULT_UNDERLYINGS,
  SyntheticFeed,
  type SyntheticOptions,
  type SyntheticUnderlying,
} from "./feeds/synthetic.js";
export { ThetadataFeed, type ThetadataOptions } from "./feeds/thetadata.js";
export { TradierFeed, type TradierOptions } from "./feeds/tradier.js";
// Feeds
export type { FeedAdapter, FeedCapabilities, RawOptionTrade, TradeFilter } from "./feeds/types.js";
// Greeks & GEX
export {
  type BsInput,
  type BsOutput,
  blackScholes,
  erf,
  intrinsicValue,
  normCdf,
  normPdf,
} from "./greeks/black-scholes.js";
export { brent, type IvSolveInput, solveIv } from "./greeks/brent.js";
export { computeGex, type GexOptions } from "./greeks/gex.js";
// Market-structure analytics (daily-history layer)
export * from "./market/index.js";
export { type NormalizeResult, normalizeTrade } from "./normalize/normalize.js";
// Symbology & conditions
export { formatOcc, formatOsi, parseOcc } from "./occ.js";
// Runner & server
export { foldChainToDaily, type RunnerOptions, type RunSummary, runEngine } from "./runner.js";
export {
  type BaselineDayRows,
  BaselineState,
  bucketFor,
  IntradayState,
  type LiquidityBucket,
} from "./score/baselines.js";
export { computeScore, type ScoreInputs } from "./score/score.js";
export { createWhaleServer, type WhaleServer } from "./server/server.js";
export { MemoryFlightRecorder } from "./store/memory.js";
export { SqliteFlightRecorder } from "./store/sqlite.js";
// Flight recorder
export type {
  ContractDailyRow,
  EventFilter,
  FlightRecorder,
  NetFlowRow,
  ShortVolumeRow,
  StoredRule,
  StoreStatus,
  TickFilter,
  UnderlyingDailyRow,
} from "./store/types.js";
// Domain types
export type * from "./types.js";
export { eventId, sha256Hex, stableStringify } from "./util/hash.js";
// Utilities that consumers legitimately need
export { LogHistogram, newPremiumHistogram, newSizeHistogram } from "./util/log-histogram.js";
export { mulberry32, type Rng } from "./util/prng.js";
export { dteOf, easternOffsetMs, easternTimeToUtc, round, sessionDateOf } from "./util/session.js";

import { AlpacaFeed as Alpaca } from "./feeds/alpaca.js";
import { MassiveFeed as Massive } from "./feeds/massive.js";
import { registerFeed as register } from "./feeds/registry.js";
import { ReplayFeed as Replay } from "./feeds/replay.js";
import { SyntheticFeed as Synthetic } from "./feeds/synthetic.js";
import { ThetadataFeed as Thetadata } from "./feeds/thetadata.js";
import { TradierFeed as Tradier } from "./feeds/tradier.js";

/** Read a required credential from the environment or fail with its name. */
function requireEnv(name: string, purpose: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${purpose} needs the ${name} environment variable (not set)`);
  }
  return value;
}

// Built-in feeds register on import; vendor adapters add themselves as they land.
register("synthetic", (config) => {
  return new Synthetic({
    seed: config.feed.synthetic.seed,
    regime: config.feed.synthetic.regime,
    eventsPerMinute: config.feed.synthetic.eventsPerMinute,
    pace: "realtime",
  });
});
register("replay", (config) => {
  if (!config.feed.tapePath) {
    throw new Error("replay feed needs feed.tapePath (an NDJSON tape file)");
  }
  return new Replay(config.feed.tapePath);
});
register("thetadata", (config) => {
  // Auth lives in the locally running Theta Terminal — no key env needed.
  return new Thetadata({
    baseUrl: process.env.THETADATA_BASE_URL ?? config.feed.thetadata.baseUrl,
    wsUrl: process.env.THETADATA_WS_URL ?? config.feed.thetadata.wsUrl,
  });
});
register("massive", (config) => {
  const apiKey = process.env.MASSIVE_API_KEY ?? process.env.POLYGON_API_KEY;
  if (!apiKey) {
    throw new Error(
      "massive feed needs the MASSIVE_API_KEY environment variable (POLYGON_API_KEY is accepted as a fallback; neither is set)",
    );
  }
  return new Massive({
    apiKey,
    stream: config.feed.massive.stream,
    restBase: config.feed.massive.restBase,
  });
});
register("alpaca", (config) => {
  return new Alpaca({
    keyId: requireEnv("ALPACA_API_KEY_ID", "alpaca feed"),
    secretKey: requireEnv("ALPACA_API_SECRET_KEY", "alpaca feed"),
    stream: config.feed.alpaca.stream,
  });
});
register("tradier", (config) => {
  return new Tradier({
    accessToken: requireEnv("TRADIER_ACCESS_TOKEN", "tradier feed"),
    apiBase: config.feed.tradier.apiBase,
  });
});
