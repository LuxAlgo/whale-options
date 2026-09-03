/*
  Per-print flow series: the intraday tape aggregated from every normalized
  print into clock buckets — signed premium, directional delta, net volume,
  and the spot tape from prints. Driven by the runner, persisted by the
  flight recorder, served by the API; the pure engine is untouched.
*/

export {
  blackScholesDeltaFromTick,
  type DeltaLookup,
  deltaLookupFromChains,
  describeDeltaSource,
  FLOW_SERIES_NOTE,
  type FlowBucketRow,
  FlowSeriesAggregator,
  type FlowSeriesOptions,
  type FlowSeriesPayload,
  type FlowSeriesPoint,
  type FlowSeriesTotals,
  flowSeriesPayload,
  resampleFlowBuckets,
  type SpotTapeBar,
  spotBarsFromBuckets,
} from "./series.js";
