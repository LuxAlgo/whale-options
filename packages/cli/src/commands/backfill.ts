/*
  `whale backfill` — kill the cold start. Ingests prior sessions through the
  feed's historical surface and folds them into the baseline tables, so the
  very first live `whale run` scores against real 20-session context instead
  of flagging everything coldStart. Zero-key path: `whale backfill --feed
  synthetic` warms baselines from deterministic generated sessions.
*/

import {
  backfill,
  createFeed,
  DEFAULT_UNDERLYINGS,
  type FlightRecorder,
  MemoryFlightRecorder,
  SqliteFlightRecorder,
  sessionDateOf,
  tradingDaysBack,
} from "@luxalgo/whale-core";
import type { Command } from "commander";
import pc from "picocolors";
import { applyOverrides, type CommonFlags, loadConfig } from "../config-load.js";

/** Feeds with a historical trade surface (adapters implementing
 *  getHistoricalOptionTrades). Kept in sync with the core adapters. */
const HISTORICAL_FEEDS = ["synthetic", "thetadata", "massive", "alpaca"] as const;

interface BackfillFlags extends CommonFlags {
  sessions?: string;
  dates?: string;
}

/** Expand "2026-08-01..2026-08-21" into the weekdays inside it, oldest first. */
function expandDateRange(range: string): string[] {
  const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(range.trim());
  if (!m?.[1] || !m[2]) {
    throw new Error(`--dates wants an ISO range like 2026-08-01..2026-08-21, got "${range}"`);
  }
  const [, fromIso, toIso] = m;
  if (fromIso > toIso) throw new Error(`--dates range is backwards: ${fromIso} > ${toIso}`);
  const out: string[] = [];
  let ts = Date.parse(`${fromIso}T00:00:00Z`);
  const endTs = Date.parse(`${toIso}T00:00:00Z`);
  while (ts <= endTs) {
    const day = new Date(ts).getUTCDay();
    if (day !== 0 && day !== 6) out.push(new Date(ts).toISOString().slice(0, 10));
    ts += 86_400_000;
  }
  if (out.length === 0) throw new Error(`--dates range ${range} contains no weekdays`);
  return out;
}

export function registerBackfill(program: Command): void {
  program
    .command("backfill")
    .description("ingest historical sessions to warm baselines: calibrated scores from day one")
    .option("--config <path>", "config file (default: whale.config.* in cwd)")
    .option("--feed <id>", `feed adapter with history: ${HISTORICAL_FEEDS.join(", ")}`)
    .option("--tickers <list>", "comma-separated underlyings to backfill")
    .option("--db <path>", "flight recorder path (':memory:' for none)")
    .option("--sessions <n>", "prior weekday sessions to ingest", "20")
    .option("--dates <range>", "explicit ISO range instead, e.g. 2026-08-01..2026-08-21")
    .option("--seed <n>", "synthetic feed seed")
    .action(async (flags: BackfillFlags) => {
      const { config } = await loadConfig(flags.config);
      applyOverrides(config, flags);

      // Zero-key parity with `whale run`: an empty universe on the synthetic
      // feed means the feed's built-in symbols.
      if (config.feed.id === "synthetic" && config.universe.underlyings.length === 0) {
        config.universe.underlyings = DEFAULT_UNDERLYINGS.map((u) => u.symbol);
      }
      if (config.universe.underlyings.length === 0) {
        throw new Error(
          "backfill needs underlyings; pass --tickers or set universe.underlyings in the config",
        );
      }

      const adapter = createFeed(config.feed.id, config);
      if (!adapter.getHistoricalOptionTrades) {
        process.stderr.write(
          `the ${pc.bold(config.feed.id)} feed has no historical trade surface, so backfill ` +
            `cannot warm baselines from it. Feeds with history: ${HISTORICAL_FEEDS.join(", ")}. ` +
            `Baselines will still accumulate from live \`whale run\` sessions.\n`,
        );
        await adapter.close?.();
        process.exitCode = 1;
        return;
      }

      const sessionsWanted = Number(flags.sessions ?? 20);
      if (!Number.isInteger(sessionsWanted) || sessionsWanted < 1) {
        throw new Error(`--sessions wants a positive integer, got "${flags.sessions}"`);
      }
      const dates = flags.dates
        ? expandDateRange(flags.dates)
        : tradingDaysBack(sessionDateOf(Date.now()), sessionsWanted);

      const store: FlightRecorder =
        config.store.path === ":memory:" || config.store.driver === "memory"
          ? new MemoryFlightRecorder()
          : new SqliteFlightRecorder(config.store.path);
      const coverageBefore = store.baselineSessionDates().length;

      process.stderr.write(
        pc.dim(
          `feed=${config.feed.id} universe=${config.universe.underlyings.join(",")} ` +
            `dates=${dates[0]}..${dates[dates.length - 1]} (${dates.length} weekdays) db=${config.store.path}\n`,
        ),
      );

      const controller = new AbortController();
      let interrupts = 0;
      process.on("SIGINT", () => {
        interrupts++;
        if (interrupts === 1) {
          process.stderr.write(pc.dim("\nstopping: the in-progress date will not be folded…\n"));
          controller.abort();
        } else {
          process.exit(130);
        }
      });

      const summary = await backfill({
        store,
        adapter,
        config,
        underlyings: config.universe.underlyings,
        dates,
        signal: controller.signal,
        onProgress: (p) => {
          if (p.phase === "trades") {
            process.stdout.write(
              `${p.date} ${pc.bold(p.underlying.padEnd(5))} … ${p.ticks.toLocaleString("en-US")} ticks\n`,
            );
          }
        },
      });

      const coverageAfter = store.baselineSessionDates().length;
      process.stderr.write(
        `\n${summary.sessions}/${dates.length} sessions ingested: ` +
          `${summary.ticksProcessed.toLocaleString("en-US")} ticks across ` +
          `${summary.contractsTouched.toLocaleString("en-US")} contracts, ` +
          `${summary.chainsFolded} chains folded into daily history\n`,
      );
      if (summary.skippedDates.length > 0) {
        process.stderr.write(
          pc.yellow(`skipped (adapter error or no data): ${summary.skippedDates.join(", ")}\n`),
        );
      }
      process.stderr.write(
        pc.dim(
          `baseline coverage: ${coverageBefore} → ${coverageAfter} sessions ` +
            `(minBaselineDays=${config.score.minBaselineDays}, lookback=${config.score.lookbackDays})\n`,
        ),
      );

      await adapter.close?.();
      store.close();
      if (summary.sessions === 0) process.exitCode = 1;
    });
}
