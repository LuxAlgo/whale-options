/*
  The seven whale_* tools. Local-only by design: the server reads the user's
  own flight recorder on the user's own machine — no keys leave the box, no
  data is redistributed. Every event payload carries the full score breakdown;
  showing the work is the product. Descriptions are written for agents: when
  to reach for each tool, what the params mean, and how the tools chain
  (recent → event, top → cite components, status first when things look empty).
*/

import {
  alertRuleSchema,
  computeGex,
  Engine,
  type FlightRecorder,
  type FlowEvent,
  sessionDateOf,
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

/** Compact event view for lists; full breakdowns come from whale_top/whale_event. */
function compactEvent(e: FlowEvent) {
  return {
    id: e.id,
    ts: e.ts,
    session_date: e.sessionDate,
    underlying: e.underlying,
    contract: e.contract,
    kind: e.kind,
    side: e.side,
    strike: e.strike,
    right: e.right,
    expiry: e.expiry,
    size: e.size,
    price: e.price,
    premium: e.premium,
    dte: e.dte,
    otm_pct: e.otmPct,
    vol_oi: e.volOiRatio,
    legs: e.legCount,
    exchanges: e.exchanges,
    score: e.score.total,
    cold_start: e.score.coldStart,
  };
}

function fullEvent(e: FlowEvent) {
  return { ...compactEvent(e), score_breakdown: e.score, reasons: e.reasons };
}

const kindEnum = z.enum(["sweep", "block", "split", "print"]);
const sideEnum = z.enum(["buy", "sell", "mid", "unknown"]);

export function registerWhaleTools(
  server: McpServer,
  deps: { store: FlightRecorder; config: WhaleConfig },
): void {
  const { store, config } = deps;

  server.registerTool(
    "whale_status",
    {
      title: "Engine & flight recorder status",
      description:
        "Health and provenance for the local Whale Options stack. Call this FIRST in a session, and again whenever another tool comes back empty or stale-looking — it separates 'the tape is quiet' from 'nothing is writing the tape'. No parameters. Returns: `live_engine` (true when a `whale run` process has heartbeated within ~15s) with `heartbeat_age_ms`; `ticks`/`events` totals plus `first_tick_ts`/`last_tick_ts`/`last_event_ts` (epoch ms — the recorded coverage, and the sane bounds for a whale_replay window); `baseline_sessions`, the most recent `baseline_dates`, and `cold_start` (true while fewer sessions of history back the scores than config requires — relay that scores carry wider uncertainty while it is); `rules` and `alerts_fired` counts; `db_size_bytes`; the engine's own counters (`engine_stats`: ticks seen/counted, events emitted/suppressed, cancels applied, open windows); and `chains_available` (which underlyings have chain snapshots — i.e. what whale_gex can answer for). How to read it: live_engine=false with events>0 means you are reading a recording, not a live tape — say so when you summarize; events=0 means nothing has written this database yet (`whale run` is the writer; this server only reads the same SQLite file, WAL-concurrent); a ticker missing from chains_available explains a whale_gex miss before you retry it.",
      inputSchema: {},
    },
    async () => {
      const s = store.status();
      const live = s.heartbeatTs !== null && Date.now() - s.heartbeatTs < 15_000;
      return json({
        live_engine: live,
        heartbeat_age_ms: s.heartbeatTs === null ? null : Date.now() - s.heartbeatTs,
        ticks: s.ticks,
        events: s.events,
        first_tick_ts: s.firstTickTs,
        last_tick_ts: s.lastTickTs,
        last_event_ts: s.lastEventTs,
        baseline_sessions: s.baselineSessions.length,
        baseline_dates: s.baselineSessions.slice(-5),
        cold_start: s.baselineSessions.length < config.score.minBaselineDays,
        rules: s.rules,
        alerts_fired: s.alertsFired,
        db_size_bytes: s.dbSizeBytes,
        engine_stats: s.engineStats,
        chains_available: store.listChainSnapshots(),
      });
    },
  );

  server.registerTool(
    "whale_recent",
    {
      title: "Recent options flow",
      description:
        "The flight recorder's most recent classified events, newest first, as compact rows: id, ts, contract (OCC symbol), kind (sweep | block | split | print), aggressor side, size, premium in dollars (price × size × 100, summed across legs), DTE, OTM %, vol/OI, leg count, exchanges, and the total whale score. Reach for it when the question is about the latest tape: 'what's flowing in NVDA right now', 'any sweeps in the last few minutes', 'show me put selling above $250K'. Filters (all optional): ticker ('NVDA'), kind ('sweep'), side ('buy' — sides come from comparing each print to the NBBO stored at print time; 'unknown' means the quote was missing or stale and the engine refused to guess), min_premium (250000 = $250K floor), limit (default 25, max 200). Rows are compact on purpose: pass any row's id to whale_event for the complete story — per-leg prints, the exact NBBO each was judged against, the reasons trail, and the full score decomposition. For 'what mattered most' ranked by score over a window, use whale_top instead; it returns breakdowns inline. Empty result? Run whale_status before concluding the tape is quiet — the engine may simply not be running against this database.",
      inputSchema: {
        ticker: z.string().optional().describe("Underlying symbol, e.g. 'NVDA'"),
        kind: kindEnum.optional().describe("Event kind: 'sweep' | 'block' | 'split' | 'print'"),
        side: sideEnum
          .optional()
          .describe("Aggressor side: 'buy' | 'sell' | 'mid' | 'unknown' (never guessed)"),
        min_premium: z
          .number()
          .min(0)
          .optional()
          .describe("Only events with premium ≥ this many dollars, e.g. 250000 for $250K"),
        limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 25)"),
      },
    },
    async ({ ticker, kind, side, min_premium, limit }) => {
      const events = store.queryEvents({
        underlying: ticker,
        kind,
        side,
        minPremium: min_premium,
        limit: limit ?? 25,
        orderBy: "ts",
      });
      return json({ count: events.length, events: events.map(compactEvent) });
    },
  );

  server.registerTool(
    "whale_top",
    {
      title: "Top-scored flow with full breakdowns",
      description:
        "The highest whale-scored events in a lookback window, each with its complete score decomposition and human-readable classification reasons — the 'show your work' tool, and the right starting point for 'anything big sweeping NVDA today, and how big a deal is it?'. Params: min_score (0–100 floor, default 60 — drop to 40 if a quiet tape returns nothing), window_minutes (lookback from the last recorded tick: 60 = the last hour, default 390 = one full session), tickers (['NVDA','TSLA'] to restrict; omit for the whole recorded universe), limit (default 10, max 50). Every event ships `score_breakdown` with all six components — volumeVsBaseline (contract day volume vs its own 20-session average), premiumVsBaseline (percentile vs the premium-size history), volOi (day volume over open interest), aggression (where prints hit the NBBO, plus sweep/ISO bonuses), urgency (DTE and OTM distance), repetition (same-contract same-side recurrence) — each with its normalized value, weight, weighted contribution, and the raw inputs behind it, plus `missing` (components whose inputs were unavailable; remaining weights renormalize rather than pretend) and `cold_start` (baselines still thin — say so, the uncertainty is wider). Scores run 0–100. When summarizing, cite components, never the bare number: 'scored 84 because day volume ran 6× its 20-day baseline and every leg lifted the offer across 3 exchanges' beats 'score 84'. Chain onward: whale_event with an id for per-leg NBBO detail; whale_gex for positioning context around the strikes that keep showing up; whale_status if the window comes back empty.",
      inputSchema: {
        min_score: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe("Score floor, e.g. 75 (default 60)"),
        window_minutes: z
          .number()
          .positive()
          .optional()
          .describe(
            "Look back this many minutes from the last recorded tick, e.g. 60 for the last hour (default 390 = one session)",
          ),
        tickers: z
          .array(z.string())
          .optional()
          .describe("Restrict to these underlyings, e.g. ['NVDA','TSLA']"),
        limit: z.number().int().min(1).max(50).optional().describe("Max events (default 10)"),
      },
    },
    async ({ min_score, window_minutes, tickers, limit }) => {
      const status = store.status();
      const end = status.lastTickTs ?? Date.now();
      const from = end - (window_minutes ?? 390) * 60_000;
      const max = limit ?? 10;
      const perTicker = (t?: string) =>
        store.queryEvents({
          underlying: t,
          minScore: min_score ?? 60,
          from,
          to: end,
          limit: max,
          orderBy: "score",
        });
      const events = (
        tickers && tickers.length > 0 ? tickers.flatMap((t) => perTicker(t)) : perTicker()
      )
        .sort((a, b) => b.score.total - a.score.total)
        .slice(0, max);
      return json({
        window: { from, to: end },
        count: events.length,
        events: events.map(fullEvent),
      });
    },
  );

  server.registerTool(
    "whale_event",
    {
      title: "One event's complete story",
      description:
        "Everything the flight recorder holds about one event id — the audit view. Use it after whale_recent or whale_top (their rows reference ids), or to trace a fired alert back to its cause (every stored alert carries its event id). Param: id — a deterministic content-hash id exactly as returned by the other tools (same tape + same config ⇒ same id, so ids survive replays). Returns the full event — contract, kind, side, size, premium, dte, `score_breakdown` with all six components and their raw inputs, and the `reasons` trail (which exchanges inside the sweep window, which sale conditions, what corroborated the call) — plus `legs_detail`: every print behind the event with seq, ts, exchange, price, size, sale conditions, spot, open interest, and `nbbo_at_print`, the exact quote each print was judged against, stored at ingest. That stored-NBBO guarantee is the flight recorder's point: an aggressor side is defensible after the fact, and side 'unknown' is the honest answer recorded when the quote was missing or stale. Errors: an unknown id returns isError with the id echoed — confirm it came from THIS database (whale_status shows coverage) and that retention has not pruned the window it lived in.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe("Event id from whale_recent / whale_top / a fired alert, e.g. 'a3f9c2…'"),
      },
    },
    async ({ id }) => {
      const event = store.getEvent(id);
      if (!event) return toolError(`no event with id '${id}' in the flight recorder`);
      return json({
        ...fullEvent(event),
        legs_detail: event.legs.map((l) => ({
          seq: l.seq,
          ts: l.ts,
          exchange: l.exchange,
          price: l.price,
          size: l.size,
          conditions: l.conditions,
          nbbo_at_print: l.nbbo,
          spot: l.spot,
          oi: l.oi,
        })),
      });
    },
  );

  server.registerTool(
    "whale_gex",
    {
      title: "Gamma exposure ladder",
      description:
        "Per-strike gamma exposure for one underlying — dollar gamma per 1% spot move, calls and puts separately plus net — with total GEX and the interpolated zero-gamma spot level. Reach for it for positioning context: 'where does hedging pressure flip for NVDA', 'are we above or below zero-gamma', or to frame the strikes whale_top keeps surfacing. Params: underlying ('NVDA'); expiry ('2026-09-18', optional) to restrict to one expiration, default all in the snapshot. Greeks come from the feed when it provides them, otherwise Black-Scholes with IV solved from quote mids (r and q from config, defaults documented). IMPORTANT — relay this every time you summarize: the sign convention is an ASSUMPTION about dealer positioning (default assumes dealers are long calls and short puts), not observed data; the response carries `convention` and `conventionNote` stating exactly which assumption produced the numbers, and config `greeks.gexConvention` flips it. Returns `snapshot_age_ms` (chains are snapshots, not a live stream — caveat an old one) and `gex`: {spot, convention, conventionNote, expiriesIncluded, perStrike: [{strike, callGex, putGex, netGex, callOi, putOi}], totalGex, zeroGamma: {level, method} | null, skippedContracts (no OI/IV/greeks — reported, never silently dropped)}. Errors: 'no chain snapshot' means the underlying is not in the running engine's universe — whale_status → chains_available lists what is; add the symbol to universe.underlyings and restart `whale run` to start snapshotting it.",
      inputSchema: {
        underlying: z.string().min(1).describe("Underlying symbol, e.g. 'NVDA'"),
        expiry: z
          .string()
          .optional()
          .describe("Restrict to one expiry, YYYY-MM-DD (e.g. '2026-09-18'); default all"),
      },
    },
    async ({ underlying, expiry }) => {
      const snapshot = store.getChainSnapshot(underlying);
      if (!snapshot) {
        return toolError(
          `no chain snapshot for '${underlying.toUpperCase()}' — add it to universe.underlyings and run \`whale run\`, or check whale_status → chains_available`,
        );
      }
      const ladder = computeGex(snapshot, {
        r: config.greeks.r,
        q: config.greeks.qByUnderlying[snapshot.underlying] ?? config.greeks.q,
        convention: config.greeks.gexConvention,
        expiry,
      });
      if (!ladder) return toolError("chain snapshot has no usable contracts (no OI/IV/greeks)");
      return json({ snapshot_age_ms: Date.now() - snapshot.ts, gex: ladder });
    },
  );

  server.registerTool(
    "whale_rules",
    {
      title: "Alert rule CRUD",
      description:
        "List, add, or remove the alert rules the live engine evaluates — reach for it when someone says 'alert me when…' or asks what alerting is already in place. action: 'list' | 'add' | 'remove'. 'list' returns every rule with its `source`: 'dynamic' rules were added here (or via the CLI) and persist in the flight recorder; 'config' rules come from whale.config.* and are re-seeded on every engine start — removing those here will not stick, edit the config file instead. 'add' takes `rule` {id, name?, match, sink, cooldownSec?}: match is a predicate over events — {minScore: 75, minPremium: 250000, tickers: ['NVDA'], kind: ['sweep'], side: ['buy'], maxDte: 30, minVolOi: 2, excludeColdStart: true (default — thin-baseline events don't fire)} — and sink is where fires go: {type: 'stdout' | 'desktop' | 'webhook' | 'discord' | 'telegram'}. Webhook sinks take a url plus optional secretEnv and template ('flow-event' posts the full event, 'order-signal' posts the compact ticker/action body executors accept); discord/telegram sinks take env-var NAMES for their credentials — never paste a raw secret into a rule. cooldownSec (default 60) throttles per-contract re-fires. Complete example: {action: 'add', rule: {id: 'nvda-big-sweeps', match: {tickers: ['NVDA'], kind: ['sweep'], minScore: 75, minPremium: 250000}, sink: {type: 'discord'}}}. An invalid rule returns the schema issues verbatim so you can fix and retry. 'remove' takes id ('nvda-big-sweeps'). Rules are evaluated by the ENGINE as it classifies — this server stores the rule, a running `whale run` picks it up on its next event, and every fire is persisted with its event id, so whale_event can audit exactly what tripped it.",
      inputSchema: {
        action: z.enum(["list", "add", "remove"]).describe("What to do: 'list' | 'add' | 'remove'"),
        rule: z
          .record(z.unknown())
          .optional()
          .describe(
            "For 'add': the full rule object, e.g. {id:'nvda-big-sweeps', match:{tickers:['NVDA'], kind:['sweep'], minScore:75}, sink:{type:'stdout'}} (validated against the rule schema)",
          ),
        id: z.string().optional().describe("For 'remove': the rule id, e.g. 'nvda-big-sweeps'"),
      },
    },
    async ({ action, rule, id }) => {
      if (action === "list") {
        return json({
          rules: store.listRules().map((r) => ({ ...r.rule, source: r.source })),
        });
      }
      if (action === "add") {
        if (!rule) return toolError("action 'add' needs a rule object");
        const parsed = alertRuleSchema.safeParse(rule);
        if (!parsed.success) {
          return toolError(
            `invalid rule: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
          );
        }
        store.upsertRule(parsed.data, "dynamic");
        return json({ ok: true, added: parsed.data.id });
      }
      if (!id) return toolError("action 'remove' needs an id");
      const removed = store.removeRule(id);
      return removed ? json({ ok: true, removed: id }) : toolError(`no rule '${id}'`);
    },
  );

  server.registerTool(
    "whale_replay",
    {
      title: "Replay a window through the current config",
      description:
        "Deterministically re-run recorded ticks through the engine under the CURRENT config and diff the result against what was recorded live — the honest way to answer 'what would my new weights/thresholds have flagged yesterday?', and the fastest sanity check after editing config, before restarting the engine. It works because every tick is self-contained (the NBBO, spot, and OI it was judged with ride on the tick) and the engine is a pure function of the tape: the replay IS what a live run with today's settings would have produced. Params: from / to — epoch ms; take them from whale_status (first_tick_ts / last_tick_ts) or from an event's ts ± some minutes. Keep windows modest (an hour to a session — every tick in range is re-classified) and ≤ 7 days (hard cap). underlying ('NVDA', optional) restricts the replay. Returns ticks_replayed, events_replayed vs events_stored, then the diff, each list capped at 20 rows: `added` (the current config would emit these; the live run did not), `removed` (recorded live; gone under the current config), `score_changed` ({id, contract, stored_score, replayed_score} — same events, different judgment). All three empty ⇒ the current config agrees with the config that ran live. One caveat when you pass `underlying`: the engine re-derives tape-relative context (block thresholds from the size distribution it sees, premium percentiles, repetition) from the restricted tape, which is not the full tape the live run saw — so a restricted replay can show differences that are about context, not config; the authoritative diff replays the full window with no underlying filter. READ-ONLY guarantee, worth relaying: replay never writes events, never re-fires alerts, never touches the store — recorded history stays exactly as recorded.",
      inputSchema: {
        from: z
          .number()
          .describe("Window start, epoch ms — e.g. whale_status → first_tick_ts, or an event ts"),
        to: z.number().describe("Window end, epoch ms (≤ 7 days after 'from')"),
        underlying: z
          .string()
          .optional()
          .describe(
            "Restrict to one underlying, e.g. 'NVDA' — faster, but tape-relative context is re-derived from the restricted tape (see description)",
          ),
      },
    },
    async ({ from, to, underlying }) => {
      if (to <= from) return toolError("'to' must be after 'from'");
      if (to - from > 7 * 86_400_000)
        return toolError("window too large — replay at most 7 days at a time");
      const baselines = store.loadBaselineState(config.score.lookbackDays, sessionDateOf(from));
      const engine = new Engine(config, baselines);
      const replayed: FlowEvent[] = [];
      let ticks = 0;
      for (const tick of store.iterateTicks({ from, to, underlying })) {
        ticks++;
        replayed.push(...engine.push(tick));
      }
      replayed.push(...engine.flush());

      const stored = store.queryEvents({ from, to, underlying, limit: 1000, orderBy: "ts" });
      const storedIds = new Set(stored.map((e) => e.id));
      const replayedIds = new Map(replayed.map((e) => [e.id, e]));
      const added = replayed.filter((e) => !storedIds.has(e.id));
      const removed = stored.filter((e) => !replayedIds.has(e.id));
      const scoreChanged = stored
        .filter((e) => replayedIds.has(e.id))
        .map((e) => ({ stored: e, replayed: replayedIds.get(e.id)! }))
        .filter((p) => p.stored.score.total !== p.replayed.score.total);

      return json({
        ticks_replayed: ticks,
        events_replayed: replayed.length,
        events_stored: stored.length,
        added: added.slice(0, 20).map(compactEvent),
        removed: removed.slice(0, 20).map(compactEvent),
        score_changed: scoreChanged.slice(0, 20).map((p) => ({
          id: p.stored.id,
          contract: p.stored.contract,
          stored_score: p.stored.score.total,
          replayed_score: p.replayed.score.total,
        })),
        note: "replay never re-fires alerts; stored events are untouched. Differences mean the current config disagrees with the config that ran live.",
      });
    },
  );
}
