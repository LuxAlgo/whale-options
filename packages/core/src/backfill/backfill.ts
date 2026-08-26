/*
  Backfill: historical ingestion that warms baselines so scores are
  calibrated on day one instead of after 20 live sessions.

  Backfill deliberately does NOT run the Engine — no events, no alerts, no
  ticks_raw. It rebuilds exactly the state a finished live session would have
  left behind: per-contract day volume and trade counts, per-underlying
  premium histograms, per-bucket trade-size histograms (all via the same
  IntradayState + policyFor + bucketFor the engine uses, so the accumulation
  is definitionally identical to live), folded into BaselineDayRows per
  session date — plus the daily OI/IV history via foldChainToDaily when the
  adapter offers as-of-date chains. Everything it writes is an overwrite-safe
  upsert, so re-running a window is idempotent.
*/
import { isCancel, policyFor } from "../conditions.js";
import type { WhaleConfig } from "../config.js";
import type { FeedAdapter } from "../feeds/types.js";
import { normalizeTrade } from "../normalize/normalize.js";
import { foldChainToDaily } from "../runner.js";
import { bucketFor, IntradayState } from "../score/baselines.js";
import type { FlightRecorder } from "../store/types.js";

export interface BackfillOptions {
  store: FlightRecorder;
  adapter: FeedAdapter;
  underlyings: string[];
  /** ISO session dates to ingest, oldest first (caller computes trading days). */
  dates: string[];
  config: WhaleConfig;
  signal?: AbortSignal;
  onProgress?: (p: {
    underlying: string;
    date: string;
    ticks: number;
    phase: "trades" | "chain";
  }) => void;
}

export interface BackfillSummary {
  /** Session dates that produced baseline rows (≥1 underlying ingested). */
  sessions: number;
  ticksProcessed: number;
  contractsTouched: number;
  chainsFolded: number;
  /** Dates where at least one (date × underlying) was skipped — adapter
   *  threw or returned nothing. A date can appear here and still count as a
   *  session when another underlying on it succeeded. */
  skippedDates: string[];
}

/**
 * The last `sessions` weekdays (Mon–Fri) strictly before `fromDateIso`,
 * oldest first. No exchange-holiday calendar — a market holiday in the
 * window simply yields an empty session that backfill skips gracefully.
 */
export function tradingDaysBack(fromDateIso: string, sessions: number): string[] {
  const [y, m, d] = fromDateIso.split("-").map(Number);
  if (!y || !m || !d) throw new Error(`invalid date: ${fromDateIso}`);
  const out: string[] = [];
  let ts = Date.UTC(y, m - 1, d);
  while (out.length < sessions) {
    ts -= 86_400_000;
    const day = new Date(ts).getUTCDay();
    if (day === 0 || day === 6) continue;
    out.push(new Date(ts).toISOString().slice(0, 10));
  }
  return out.reverse();
}

/**
 * Ingest historical sessions into the flight recorder's baseline tables.
 *
 * Per (date × underlying): stream the adapter's historical trades through
 * normalizeTrade and accumulate what the engine's intraday state would have
 * held; per date: fold once across all underlyings and saveBaselineDay (one
 * row-set per session date — exactly what a live session leaves behind).
 * As-of-date chains fold into contract/underlying daily history.
 */
export async function backfill(opts: BackfillOptions): Promise<BackfillSummary> {
  const { store, adapter, config, signal } = opts;
  if (!adapter.getHistoricalOptionTrades) {
    throw new Error(
      `feed "${adapter.id}" has no historical trade surface; backfill needs getHistoricalOptionTrades`,
    );
  }
  const getTrades = adapter.getHistoricalOptionTrades.bind(adapter);
  const underlyings = opts.underlyings.map((u) => u.toUpperCase());
  const dates = [...opts.dates].sort();

  // Hydrate only sessions strictly before the window: bucket classification
  // reads prior-day averages, and anchoring at dates[0] keeps re-runs of the
  // same window byte-identical instead of feeding on their own output.
  const baselines = store.loadBaselineState(config.score.lookbackDays, dates[0]);

  const contractsTouched = new Set<string>();
  const skipped = new Set<string>();
  let sessions = 0;
  let ticksProcessed = 0;
  let chainsFolded = 0;
  let seq = 0;

  for (const date of dates) {
    if (signal?.aborted) break;
    const intraday = new IntradayState();
    let dateHadData = false;

    for (const underlying of underlyings) {
      if (signal?.aborted) break;
      let pairTicks = 0;
      try {
        for await (const raw of getTrades(underlying, date, signal)) {
          const { tick } = normalizeTrade(raw, adapter.id, seq, (code) =>
            adapter.normalizeCondition(code),
          );
          if (!tick) continue;
          seq = Math.max(seq, tick.seq) + 1;
          pairTicks++;
          ticksProcessed++;

          // Mirror Engine.push exactly — same policy gates, same order.
          if (isCancel(tick.conditions)) {
            intraday.removeVolume(tick.contract, tick.size);
            continue;
          }
          const policy = policyFor(tick.conditions);
          if (!policy.countsVolume) continue;
          intraday.addVolume(tick.contract, tick.size);
          contractsTouched.add(tick.contract);
          if (policy.scoreEligible) {
            intraday.addPremiumSample(tick.underlying, tick.price * tick.size * 100);
            // Same mild chicken-and-egg as live: the bucket comes from the
            // average over already-ingested prior days, falling back to the
            // day volume so far when this contract has no history yet. Day
            // one of a backfill window therefore classifies from intraday
            // volume alone — exactly what a live engine does on its first
            // session.
            const avg = baselines.avgDailyVolume(tick.contract) ?? intraday.volumeOf(tick.contract);
            intraday.addSizeSample(bucketFor(avg, config.engine.block.bucketBounds), tick.size);
          }
        }
      } catch {
        // One vendor failure degrades one (date × underlying), never the run.
        skipped.add(date);
        continue;
      }
      if (pairTicks === 0) {
        skipped.add(date);
        continue;
      }
      dateHadData = true;
      opts.onProgress?.({ underlying, date, ticks: pairTicks, phase: "trades" });

      // As-of-date chain → OI-delta/IV/spot-close history (upserts, idempotent).
      if (adapter.getHistoricalChain) {
        try {
          const snap = await adapter.getHistoricalChain(underlying, date);
          if (snap && snap.contracts.length > 0) {
            foldChainToDaily(store, snap);
            chainsFolded++;
            opts.onProgress?.({ underlying, date, ticks: pairTicks, phase: "chain" });
          }
        } catch {
          // A missing chain degrades OI/IV history for that pair only.
        }
      }
    }

    // Never fold a partially ingested date (abort mid-stream) — a truncated
    // day written as a baseline would bias every score against it.
    if (signal?.aborted) break;

    if (dateHadData) {
      const rows = intraday.fold(date);
      store.saveBaselineDay(rows);
      baselines.applyDay(rows);
      sessions++;
    } else {
      skipped.add(date);
    }
  }

  return {
    sessions,
    ticksProcessed,
    contractsTouched: contractsTouched.size,
    chainsFolded,
    skippedDates: [...skipped].sort(),
  };
}
