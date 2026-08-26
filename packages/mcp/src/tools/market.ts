/*
  Market-structure tools over the flight recorder's daily-history layer:
  OI deltas, max pain, IV rank, and net-flow leaderboards. Same contract as
  tools.ts — local-only reads of the user's own SQLite file, descriptions
  written for agents, and every honesty caveat (history windows, statics vs
  predictions, emitted-events-only) carried in the payload so it can be
  relayed, never silently dropped. The integrator wires registerMarketTools
  next to registerWhaleTools.
*/

import {
  type FlightRecorder,
  ivRank,
  maxPain,
  netFlowReport,
  oiDeltas,
  type WhaleConfig,
} from "@luxalgo/whale-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function json(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

export function registerMarketTools(
  server: McpServer,
  deps: { store: FlightRecorder; config: WhaleConfig },
): void {
  // config rides in deps for signature parity with registerWhaleTools; the
  // market tools currently read the store only.
  const { store } = deps;

  server.registerTool(
    "whale_oi_deltas",
    {
      title: "Open-interest deltas between sessions",
      description:
        "Session-to-session open-interest change for one underlying, from the flight recorder's contract_daily history — per contract (ranked by |ΔOI|), aggregated per strike and per expiry. Reach for it when the question is what changed overnight in a name's option chain: 'which NVDA strikes added the most open interest', 'did OI build or unwind into Friday's expiry'. OI settles overnight, so the honest unit of change is session-to-session — this tool NEEDS at least 2 recorded sessions of daily history; with fewer it returns empty lists and a `note` telling you to run the engine across sessions or `whale backfill` — relay that note instead of concluding nothing changed. Params: underlying ('NVDA'); sessions (2 = latest vs previous session, the default; 5 = latest vs 4 sessions back — the comparison is endpoints of the window, not day-by-day); top (max contract rows, default 20 — strike/expiry aggregates always cover ALL qualifying contracts); min_oi (drop contracts whose OI never reached this on either session, e.g. 100 to cut dust). Returns `from_date`/`to_date` (the two sessions compared), `contracts` [{contract, expiry, strike, right, prevOi, currOi, deltaOi, deltaPct, newContract}] — `newContract: true` means no row existed on the earlier session (new to the chain; deltaPct is null, there is no base) — plus `byStrike` and `byExpiry` rollups. Keep summaries descriptive: 'open interest rose 40% at the 200 strike' is what the data says; who opened those contracts or why is not in the data, so never claim it.",
      inputSchema: {
        underlying: z.string().min(1).describe("Underlying symbol, e.g. 'NVDA'"),
        sessions: z
          .number()
          .int()
          .min(2)
          .optional()
          .describe("Window in recorded sessions: 2 = latest vs previous (default)"),
        top: z.number().int().min(1).max(200).optional().describe("Max contract rows (default 20)"),
        min_oi: z
          .number()
          .min(0)
          .optional()
          .describe("Ignore contracts below this OI on both sessions, e.g. 100"),
      },
    },
    async ({ underlying, sessions, top, min_oi }) => {
      return json(oiDeltas(store, underlying, { sessions, top, minOi: min_oi }));
    },
  );

  server.registerTool(
    "whale_max_pain",
    {
      title: "Max pain per expiry",
      description:
        "The OI-weighted max-pain strike for each expiry of one underlying: the candidate settlement price (evaluated at every listed strike) minimizing the total intrinsic value option holders would collect at expiration — payout(S) = Σ calls OI×max(0,S−K)×100 + Σ puts OI×max(0,K−S)×100. Use it for expiry framing: 'where is max pain for NVDA this Friday', 'how far is spot from the pain strike'. IMPORTANT — the response's `note` states that max pain is a STATIC computed from current open interest, a description of where expiring would pay holders least, NOT a prediction of where price will go; relay that note every time you cite the number. Params: underlying ('NVDA'); expiry ('2026-09-18', optional) to restrict to one expiration, default all recorded expiries. OI comes from the latest chain snapshot when one exists, else the latest contract_daily session — `source`, `asOfTs`/`sessionDate` in the response say which, so caveat stale data. Returns `spot` (for distance context) and `expiries` [{expiry, maxPainStrike, totalPayoutAtStrike (dollars paid to holders at that settlement), callOi, putOi, strikesEvaluated, spot, note}]. Empty `expiries` with a note means no chain data (or no OI) is recorded for the symbol — whale_status → chains_available shows what the engine is snapshotting.",
      inputSchema: {
        underlying: z.string().min(1).describe("Underlying symbol, e.g. 'NVDA'"),
        expiry: z
          .string()
          .optional()
          .describe("Restrict to one expiry, YYYY-MM-DD (e.g. '2026-09-18'); default all"),
      },
    },
    async ({ underlying, expiry }) => {
      return json(maxPain(store, underlying, expiry));
    },
  );

  server.registerTool(
    "whale_iv_rank",
    {
      title: "IV rank & percentile over recorded history",
      description:
        "Where the current ATM implied volatility of one underlying sits inside its RECORDED history: ivRank = (current − min) / (max − min), ivPercentile = fraction of recorded sessions with ATM IV below today's, plus the raw current/min/max values. Reach for it to frame vol level: 'is NVDA IV high or low right now', 'rank the IV before comparing premium'. THE WINDOW CAVEAT IS THE POINT: the conventional 'IV rank' assumes a 52-week window, but this store only holds the sessions the engine (or `whale backfill`) has actually recorded — `historyDays` is the real window and the `note` says so explicitly whenever it is under 60 sessions ('rank over N sessions, not a 52-week window'); relay that note with any rank you cite. Param: underlying ('NVDA'). Returns {currentIv, minIv, maxIv, ivRank (0..1, null when recorded min equals max — a one-day or flat history has no range), ivPercentile (0..1), historyDays, firstDate, lastDate, note}. All-null values with historyDays 0 mean no ATM-IV history is recorded for the symbol — run the engine across sessions or `whale backfill`, then retry. ATM IV is the C/P-averaged IV of the nearest-the-money near-dated contracts folded in at each session's last chain refresh.",
      inputSchema: {
        underlying: z.string().min(1).describe("Underlying symbol, e.g. 'NVDA'"),
      },
    },
    async ({ underlying }) => {
      return json(ivRank(store, underlying));
    },
  );

  server.registerTool(
    "whale_net_flow",
    {
      title: "Net premium flow leaderboard",
      description:
        "Per-underlying net options premium over a lookback window, ranked by |netPremium| — the leaderboard for 'where did premium tilt today'. Sign convention (also in the response `note`, relay it): netPremium = (call buys − call sells) − (put buys − put sells), so positive is bullish-tilted premium and negative bearish-tilted — a description of which side paid, not of anyone's intent. Params: window_minutes (lookback from the last recorded event: 60 = the last hour, default 390 = one full session), top (max leaderboard rows, default 15 — `totals` always sums the WHOLE window across all underlyings, not just the capped rows). Returns {from, to, rows: [{underlying, events, callBuyPremium, callSellPremium, putBuyPremium, putSellPremium, callNet, putNet, netPremium}], totals, note}. Two honesty notes to carry into summaries: (1) this aggregates EMITTED events only — the engine's premium floor and emit policy apply, so it reflects the recorded event tape, not total market volume; (2) sides come from NBBO comparison at print time — events whose side was unknown count toward `events` but move no premium bucket. Empty rows? whale_status separates 'quiet tape' from 'nothing writing this database'.",
      inputSchema: {
        window_minutes: z
          .number()
          .positive()
          .optional()
          .describe(
            "Look back this many minutes from the last recorded event, e.g. 60 (default 390 = one session)",
          ),
        top: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max leaderboard rows (default 15); totals always cover the full window"),
      },
    },
    async ({ window_minutes, top }) => {
      const status = store.status();
      const to = status.lastEventTs ?? status.lastTickTs ?? Date.now();
      const from = to - (window_minutes ?? 390) * 60_000;
      return json(netFlowReport(store, from, to, { top: top ?? 15 }));
    },
  );
}
