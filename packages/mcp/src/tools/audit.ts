/*
  whale_audit — outcome calibration of recorded whale scores against forward
  moves of the underlying, computed on the user's own flight recorder. The
  tool exists because the honest answer to "do high scores mean anything?" is
  a measurement the user can run on their own tape — not a marketed number.
  The caveats array in every response is part of the result, not decoration.
*/

import {
  AUDIT_HORIZONS,
  type AuditHorizon,
  calibrate,
  type FlightRecorder,
  type WhaleConfig,
} from "@luxalgo/whale-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function json(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

export function registerAuditTools(
  server: McpServer,
  deps: { store: FlightRecorder; config: WhaleConfig },
): void {
  const { store } = deps;

  server.registerTool(
    "whale_audit",
    {
      title: "Score calibration vs forward underlying moves",
      description:
        "Calibrate the whale scores THIS flight recorder produced against what the underlying actually did afterwards — a measurement of the user's own recorded tape, never a performance claim and never trading advice. Reach for it when someone asks 'do high scores mean anything?', 'how calibrated is the score on my data?', or wants to sanity-check the instrument after recording for a while. Params (all optional): horizon — '15m' | '1h' (forward price = the spot on the first recorded tick of the underlying at event time + horizon, accepted within a 20-minute tolerance), 'eod' (the session's recorded close), '1d' | '5d' (the close of the 1st/5th RECORDED session after the event's session, from the daily-history table — null when history is missing); default '1h'. from / to — epoch ms window; defaults to the full recorded range (whale_status shows coverage). ticker ('NVDA') restricts to one underlying. exclude_cold_start=true drops events scored before baselines had enough history. Returns a CalibrationReport: eventsConsidered, eventsWithOutcome, `excluded` {mid, unknown, noPriceData} — mid/unknown-side events have no direction to be aligned with and are excluded, counted, and reported, never silently dropped; `buckets` (fixed 10-point score bins '0–10'…'90–100', empty bins omitted), `byKind` (sweep/block/split/print) and `bySide` (buy/sell), each row carrying n, medianFwdReturnPct, meanFwdReturnPct (percent moves of the UNDERLYING over the horizon), alignedPct (fraction where the underlying moved the event's way: buy → up, sell → down; an exact-zero move counts as NOT aligned), and smallN (n < 30 — read as noise); `baseRate` — alignedPct and median forward return across ALL events with an outcome in the same window, the honest comparator alongside the 50% coin flip; and `caveats` — ALWAYS populated. Non-negotiable when you summarize: relay the caveats with the numbers, compare every bucket to baseRate rather than quoting alignedPct alone, and never present the output as a performance claim or a forecast — option P&L is deliberately NOT computed (path- and spread-dependent; the caveats say why), so an aligned underlying move does not mean the option made money. If the caveats include the SYNTHETIC TAPE warning, the tape came from the seeded demo feed: outcomes are meaningless by construction and the run demonstrates the instrument only — say exactly that. Empty or thin results? whale_status separates 'short recording' from 'nothing writing the tape'; cross-session horizons additionally need daily history rows (recorded closes), which a fresh install will not have yet.",
      inputSchema: {
        horizon: z
          .enum(AUDIT_HORIZONS as [AuditHorizon, ...AuditHorizon[]])
          .optional()
          .describe("Forward horizon: '15m' | '1h' | 'eod' | '1d' | '5d' (default '1h')"),
        from: z
          .number()
          .optional()
          .describe("Window start, epoch ms (default: first recorded tick — see whale_status)"),
        to: z.number().optional().describe("Window end, epoch ms (default: last recorded tick)"),
        ticker: z.string().optional().describe("Restrict to one underlying, e.g. 'NVDA'"),
        exclude_cold_start: z
          .boolean()
          .optional()
          .describe("Drop events scored before baselines had enough history (default false)"),
      },
    },
    async ({ horizon, from, to, ticker, exclude_cold_start }) => {
      const status = store.status();
      const windowFrom = from ?? status.firstTickTs;
      const windowTo = to ?? status.lastTickTs ?? status.lastEventTs;
      if (windowFrom === null || windowFrom === undefined) {
        return toolError(
          "nothing recorded yet — the flight recorder has no ticks (whale_status shows coverage; pass from/to to override)",
        );
      }
      if (windowTo === null || windowTo === undefined || windowTo <= windowFrom) {
        return toolError("empty window — 'to' must be after 'from' (whale_status shows coverage)");
      }
      const report = await calibrate({
        store,
        from: windowFrom,
        to: windowTo,
        horizon: horizon ?? "1h",
        underlying: ticker,
        excludeColdStart: exclude_cold_start,
      });
      return json(report);
    },
  );
}
