/*
  Net-flow leaderboard — a thin, honest wrapper over store.netFlow. Adds
  per-underlying callNet/putNet convenience fields and a market-wide totals
  row. Sign convention (from the store): netPremium = (call buys − call
  sells) − (put buys − put sells), so positive reads bullish-tilted premium.
  The aggregation runs over EMITTED events only — the engine's premium floor
  and emit policy apply — so this is the recorded event tape's tilt, not
  total market volume.
*/

import type { FlightRecorder, NetFlowRow } from "../store/types.js";
import { round } from "../util/session.js";

export const NET_FLOW_NOTE =
  "netPremium = (call buys − call sells) − (put buys − put sells): positive is " +
  "bullish-tilted premium. Aggregated from EMITTED events only (the engine's premium " +
  "floor and emit policy apply), so this reflects the recorded event tape, not total " +
  "market volume; sides come from NBBO comparison and unsided events count toward " +
  "`events` but move no premium bucket.";

export interface NetFlowReportRow extends NetFlowRow {
  /** callBuyPremium − callSellPremium. */
  callNet: number;
  /** putBuyPremium − putSellPremium. */
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
  /** Ranked by |netPremium| descending (store order), capped at opts.top. */
  rows: NetFlowReportRow[];
  /** Market-wide sums over ALL underlyings in the window, not just the capped rows. */
  totals: NetFlowTotals;
  note: string;
}

export function netFlowReport(
  store: FlightRecorder,
  from: number,
  to: number,
  opts: { top?: number } = {},
): NetFlowReport {
  const all = store.netFlow(from, to).map((r) => ({
    ...r,
    callNet: round(r.callBuyPremium - r.callSellPremium, 2),
    putNet: round(r.putBuyPremium - r.putSellPremium, 2),
  }));

  const totals: NetFlowTotals = {
    underlyings: all.length,
    events: 0,
    callBuyPremium: 0,
    callSellPremium: 0,
    putBuyPremium: 0,
    putSellPremium: 0,
    callNet: 0,
    putNet: 0,
    netPremium: 0,
  };
  for (const r of all) {
    totals.events += r.events;
    totals.callBuyPremium = round(totals.callBuyPremium + r.callBuyPremium, 2);
    totals.callSellPremium = round(totals.callSellPremium + r.callSellPremium, 2);
    totals.putBuyPremium = round(totals.putBuyPremium + r.putBuyPremium, 2);
    totals.putSellPremium = round(totals.putSellPremium + r.putSellPremium, 2);
    totals.callNet = round(totals.callNet + r.callNet, 2);
    totals.putNet = round(totals.putNet + r.putNet, 2);
    totals.netPremium = round(totals.netPremium + r.netPremium, 2);
  }

  return {
    from,
    to,
    rows: opts.top !== undefined ? all.slice(0, opts.top) : all,
    totals,
    note: all.length === 0 ? `no events recorded in this window; ${NET_FLOW_NOTE}` : NET_FLOW_NOTE,
  };
}
