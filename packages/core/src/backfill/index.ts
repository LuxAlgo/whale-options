/*
  Backfill barrel — historical ingestion that warms baselines so scores are
  calibrated from the first live session.
*/
export {
  type BackfillOptions,
  type BackfillSummary,
  backfill,
  tradingDaysBack,
} from "./backfill.js";
