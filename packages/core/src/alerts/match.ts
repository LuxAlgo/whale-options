/*
  Alert rule matching — plain predicates over FlowEvents. Rules are JSON
  (validated by alertRuleSchema in config.ts), stored in the flight recorder,
  and every fire records the event id so the alert is replayable end to end.
*/
import type { AlertRule } from "../config.js";
import type { FlowEvent } from "../types.js";

export function ruleMatches(rule: AlertRule, event: FlowEvent): boolean {
  if (!rule.enabled) return false;
  const m = rule.match;
  if (m.minScore !== undefined && event.score.total < m.minScore) return false;
  if (m.minPremium !== undefined && event.premium < m.minPremium) return false;
  if (m.tickers && m.tickers.length > 0) {
    const tickers = m.tickers.map((t) => t.toUpperCase());
    if (!tickers.includes(event.underlying)) return false;
  }
  if (m.side && m.side.length > 0 && !m.side.includes(event.side)) return false;
  if (m.kind && m.kind.length > 0 && !m.kind.includes(event.kind)) return false;
  if (m.maxDte !== undefined && event.dte > m.maxDte) return false;
  if (m.minVolOi !== undefined) {
    if (event.volOiRatio === null || event.volOiRatio < m.minVolOi) return false;
  }
  if (m.excludeColdStart && event.score.coldStart) return false;
  return true;
}
