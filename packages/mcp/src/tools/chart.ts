/*
  Chart-side tools over the flight recorder: the per-print flow series (what
  the dashboard's chart panes plot), underlying bars from the spot tape, and
  the strike-by-expiry GEX heatmap with live re-pricing. Same contract as
  tools.ts — local reads of the user's own SQLite file, descriptions written
  for agents, and every honesty note (no premium floor here, delta source,
  spot tape ≠ exchange bars, dealer convention as an assumption, chain time
  vs re-pricing time) carried in the payload so it can be relayed, never
  silently dropped. The integrator wires registerChartTools next to the rest.
*/

import {
  BAR_TIMEFRAME_MS,
  computeGexHeatmap,
  type FlightRecorder,
  flowSeriesPayload,
  parseBarTimeframe,
  resampleFlowBuckets,
  sessionDateOf,
  spotBarsFromBuckets,
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

const SPOT_TAPE_BARS_NOTE =
  "SPOT TAPE FROM PRINTS: these bars are the underlying-price observations that rode on the " +
  "option prints (tick.spot) in the flight recorder, folded to the timeframe — not exchange " +
  "equity bars. A bar exists only where options printed, volume is null, and gaps are minutes " +
  "with no prints. The engine's HTTP API (GET /api/bars/:underlying while `whale run` is up) " +
  "serves the feed's own equity bars when the vendor has them; this MCP server reads the " +
  "recorder only, so it serves the spot tape and says so.";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "ISO date, e.g. 2026-08-24")
  .optional();

export function registerChartTools(
  server: McpServer,
  deps: { store: FlightRecorder; config: WhaleConfig },
): void {
  const { store, config } = deps;

  /** The recorder's newest recorded session for a name, else today's (ET). */
  const defaultSession = (underlying: string): string => {
    const dates = store.flowSessionDates(underlying);
    return dates[dates.length - 1] ?? sessionDateOf(Date.now());
  };

  server.registerTool(
    "whale_flow_series",
    {
      title: "Per-print flow series (net premium, directional delta, net volume)",
      description:
        "The intraday flow series for one underlying and one session, bucketed on the clock and built from EVERY normalized print — NOT just the events whale_recent/whale_top return: the engine's premium floor and emit policy do not apply here, so this is the whole tape's tilt, not the event stream's. Reach for it for 'how has premium been flowing in NVDA today', 'is the tape net buying calls or puts', 'what is the cumulative directional delta', or to describe the shape of a session before citing individual events. Params: underlying ('NVDA'); session_date (YYYY-MM-DD, default the newest recorded session for that name — whale_status → last_tick_ts and GET /api/flow/sessions say what exists); bucket_minutes (1 = the stored resolution, default; 5 or 15 re-bucket onto a coarser grid — must be a multiple of the stored width); limit (max buckets returned, newest kept, default all). Returns `buckets` ascending by `ts` (bucket start, epoch ms), each with the raw counts (prints, cancels, sided, unsided), positive premium amounts per side and right (callPremiumBuy/Sell, putPremiumBuy/Sell), the derived signed values (callNet, putNet, netPremium = callNet − putNet, bullish-positive — the same convention as whale_net_flow), directionalDelta (Σ delta × size × 100 × sign), netVolume (buy − sell contracts), the running cumulatives (cumCallNet, cumPutNet, cumNetPremium, cumDirectionalDelta, cumNetVolume), the delta-source counts (deltaFromChain, deltaFromBlackScholes, deltaMissing), and the spot tape (spotOpen/High/Low/Close from the prints' own spot observations). Also `totals` for the session, `deltaSource` (in words: how many prints used chain-snapshot greeks vs Black-Scholes from the print's own NBBO mid/spot, how many had no derivable delta and were excluded), and `note`. RELAY THE NOTE: sign comes only from a trustworthy aggressor side (mid/unknown prints and side-voiding sale conditions are counted in `unsided`, never signed); cancels are counted, never retracted; delta is never guessed; the spot series is a tape from option prints, not exchange bars; values reset per session date. Empty buckets with a fresh session_date mean nothing has printed yet — whale_status separates quiet from not-running.",
      inputSchema: {
        underlying: z.string().min(1).describe("Underlying symbol, e.g. 'NVDA'"),
        session_date: isoDate.describe(
          "Session date YYYY-MM-DD (America/New_York); default the newest recorded session for the name",
        ),
        bucket_minutes: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Bucket width in minutes: 1 (stored, default), 5, 15, … (a multiple of the stored width)",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe("Max buckets, newest kept (default all)"),
      },
    },
    async ({ underlying, session_date, bucket_minutes, limit }) => {
      const symbol = underlying.toUpperCase();
      const session = session_date ?? defaultSession(symbol);
      const rows = store.getFlowBuckets(symbol, session);
      const stored = rows[0]?.bucketMs ?? config.flowSeries.bucketMs;
      const bucketMs = bucket_minutes === undefined ? stored : bucket_minutes * 60_000;
      let resampled: ReturnType<typeof resampleFlowBuckets>;
      try {
        resampled = resampleFlowBuckets(rows, bucketMs);
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
      const payload = flowSeriesPayload(symbol, session, resampled, bucketMs);
      const buckets =
        limit !== undefined && payload.buckets.length > limit
          ? payload.buckets.slice(payload.buckets.length - limit)
          : payload.buckets;
      return json({
        ...payload,
        buckets,
        buckets_total: payload.buckets.length,
        recorded_sessions: store.flowSessionDates(symbol),
      });
    },
  );

  server.registerTool(
    "whale_bars",
    {
      title: "Underlying bars from the spot tape",
      description:
        "OHLC bars of the UNDERLYING for one session, built from the spot observations that rode on the option prints in the flight recorder — the 'spot tape from prints'. Reach for it when you need the price path behind the flow ('where was NVDA when those sweeps hit', 'did spot rise after the put selling') without leaving the recorder. Params: underlying ('NVDA'); timeframe ('1m' | '5m' | '15m' | '1h' | '1d', default '5m'); session_date (YYYY-MM-DD, default the newest recorded session for the name); limit (max bars, newest kept, default all). Returns `bars` ascending by `ts` (bar open, epoch ms) with open/high/low/close, `observations` (how many prints observed a spot inside the bar — a tape density, not share volume) and `volume: null`, plus `source: 'spot-tape-from-prints'` and `note`. RELAY THE SOURCE every time you cite a price: these are NOT exchange equity bars — a bar exists only where options printed, gaps are minutes with no prints, and there is no share volume. The engine's own HTTP API (GET /api/bars while `whale run` is up) serves the vendor's equity bars when the feed has them (Alpaca, Massive) and falls back to this same spot tape otherwise; this MCP server reads the recorder only, so it always serves the spot tape and says so. Empty `bars` means no prints with a spot were recorded for that session — check whale_status and the recorded_sessions list.",
      inputSchema: {
        underlying: z.string().min(1).describe("Underlying symbol, e.g. 'NVDA'"),
        timeframe: z
          .string()
          .optional()
          .describe("Bar timeframe: '1m' | '5m' | '15m' | '1h' | '1d' (default '5m')"),
        session_date: isoDate.describe(
          "Session date YYYY-MM-DD (America/New_York); default the newest recorded session for the name",
        ),
        limit: z.number().int().min(1).max(2000).optional().describe("Max bars, newest kept"),
      },
    },
    async ({ underlying, timeframe, session_date, limit }) => {
      const tf = parseBarTimeframe(timeframe ?? "5m");
      if (!tf) return toolError(`unknown timeframe '${timeframe}'; one of 1m, 5m, 15m, 1h, 1d`);
      const symbol = underlying.toUpperCase();
      const session = session_date ?? defaultSession(symbol);
      const rows = store.getFlowBuckets(symbol, session);
      const all = spotBarsFromBuckets(rows, BAR_TIMEFRAME_MS[tf]).map((b) => ({
        ...b,
        volume: null,
      }));
      const bars = limit !== undefined && all.length > limit ? all.slice(all.length - limit) : all;
      return json({
        underlying: symbol,
        session_date: session,
        timeframe: tf,
        timeframe_ms: BAR_TIMEFRAME_MS[tf],
        source: "spot-tape-from-prints",
        bars,
        bars_total: all.length,
        recorded_sessions: store.flowSessionDates(symbol),
        note: SPOT_TAPE_BARS_NOTE,
      });
    },
  );

  server.registerTool(
    "whale_gex_heatmap",
    {
      title: "GEX heatmap (strike × expiry), re-priceable at a live spot",
      description:
        "Net gamma exposure as a strike-by-expiry grid for one underlying: rows are the strikes nearest spot, columns the chain's expiries, each cell the net dollar gamma per 1% spot move (Γ × OI × 100 × S² × 0.01, calls and puts netted) for that strike and expiry, with `strikeTotals` (the all-expiry ladder at each row), `expiryTotals` (each expiry's WHOLE ladder, including rows not shown), `totalGex`, the `spotRowIndex` (the row to highlight), `zeroGamma` {level, method}, and `strikesOmitted`. Reach for it when whale_gex's single ladder is not enough: 'which expiry carries the gamma at 200', 'is the near-dated pin at a different strike than the monthly', 'where does hedging pressure concentrate this week vs next'. Params: underlying ('NVDA'); rows (strike rows around spot, default 21); spot (optional positive number) to RE-PRICE the snapshotted chain at a fresher spot — OI, IV and feed greeks stay as snapshotted, only the gamma weights move, and `pricing.note` then reads 'chain as of <ts>, re-priced at spot <x> at <ts>'; without it the grid is priced at the snapshot's own spot. TWO THINGS TO RELAY EVERY TIME: (1) `conventionNote` — the sign convention is an ASSUMPTION about dealer positioning (default: dealers long calls, short puts), not observed data, and config greeks.gexConvention flips it; (2) `pricing.note` — chains are snapshots, and a re-priced grid is old open interest evaluated at a new price, not a new chain. Also returns `snapshot_age_ms`. Errors: 'no chain snapshot' means the name is not in the running engine's universe — whale_status → chains_available lists what is.",
      inputSchema: {
        underlying: z.string().min(1).describe("Underlying symbol, e.g. 'NVDA'"),
        rows: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Strike rows nearest spot to include (default 21)"),
        spot: z
          .number()
          .positive()
          .optional()
          .describe(
            "Re-price the snapshotted chain at this spot (e.g. the latest print's spot); omit to use the snapshot's own",
          ),
      },
    },
    async ({ underlying, rows, spot }) => {
      const snapshot = store.getChainSnapshot(underlying);
      if (!snapshot) {
        return toolError(
          `no chain snapshot for '${underlying.toUpperCase()}' — add it to universe.underlyings and run \`whale run\`, or check whale_status → chains_available`,
        );
      }
      const heatmap = computeGexHeatmap(snapshot, {
        r: config.greeks.r,
        q: config.greeks.qByUnderlying[snapshot.underlying] ?? config.greeks.q,
        convention: config.greeks.gexConvention,
        rows,
        spot,
        repricedTs: spot === undefined ? undefined : Date.now(),
      });
      if (!heatmap) return toolError("chain snapshot has no usable contracts (no OI/IV/greeks)");
      return json({ snapshot_age_ms: Date.now() - snapshot.ts, heatmap });
    },
  );
}
