/*
  `whale context short-volume <symbol>` — FINRA daily short-sale volume from
  the flight recorder's cache. End-of-day context, never real-time: the note
  saying so prints with every report. `--sync` fills the cache from FINRA's
  public daily files (fetched directly by this installation, filtered to the
  configured universe, never redistributed).
*/

import { SqliteFlightRecorder, shortVolumeReport, syncShortVolume } from "@luxalgo/whale-core";
import type { Command } from "commander";
import pc from "picocolors";
import { applyOverrides, type CommonFlags, loadConfig } from "../config-load.js";

interface ShortVolumeFlags extends CommonFlags {
  days?: string;
  sync?: boolean;
  json?: boolean;
}

function qty(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return String(v);
}

function ratioBar(ratio: number): string {
  const width = Math.round(Math.min(1, Math.max(0, ratio)) * 20);
  return "█".repeat(width) + "·".repeat(20 - width);
}

export function registerContext(program: Command): void {
  const context = program
    .command("context")
    .description("end-of-day context datasets (FINRA short-sale volume)");

  context
    .command("short-volume <symbol>")
    .description("FINRA daily short-sale volume history from the local cache (EOD, not real-time)")
    .option("--config <path>")
    .option("--db <path>")
    .option("--days <n>", "weekdays of history", "20")
    .option("--sync", "fetch missing days from FINRA before reporting")
    .option("--json", "machine-readable output")
    .action(async (symbol: string, flags: ShortVolumeFlags) => {
      const { config } = await loadConfig(flags.config);
      applyOverrides(config, flags);
      const sym = symbol.toUpperCase();
      const days = Number(flags.days ?? 20);
      if (!Number.isInteger(days) || days < 1) throw new Error("--days must be a positive integer");

      const store = new SqliteFlightRecorder(config.store.path);
      try {
        if (flags.sync) {
          // One FINRA file covers the whole market, so sync the configured
          // universe alongside the requested symbol — same downloads either way.
          const symbols = [...new Set([sym, ...config.universe.underlyings])];
          const result = await syncShortVolume({ store, symbols, days });
          process.stderr.write(
            pc.dim(
              `sync: ${result.daysFetched} day(s) fetched from FINRA, ` +
                `${result.daysSkipped.length} skipped (cached / no file), ` +
                `${result.rowsStored} rows stored for ${symbols.length} symbol(s)\n`,
            ),
          );
        }

        const report = shortVolumeReport(store, sym, days);
        if (flags.json) {
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
          return;
        }

        if (report.days.length === 0) {
          process.stdout.write(
            pc.dim(
              `no cached short-volume rows for ${sym}` +
                (flags.sync
                  ? "; FINRA published no file for the requested days, or the symbol has no off-exchange prints\n"
                  : `; run \`whale context short-volume ${sym} --sync\` to fetch from FINRA\n`),
            ),
          );
          process.stdout.write(`${pc.dim(report.note)}\n`);
          return;
        }

        process.stdout.write(
          `${pc.bold(sym)} FINRA short-sale volume, last ${report.days.length} session(s)\n`,
        );
        process.stdout.write(
          pc.dim(`  ${"date".padEnd(12)}${"short".padStart(9)}${"total".padStart(9)}   ratio\n`),
        );
        for (const day of report.days) {
          const ratio =
            day.shortRatio === null
              ? "   n/a"
              : `${(day.shortRatio * 100).toFixed(1).padStart(5)}%`;
          const bar = day.shortRatio === null ? "" : `  ${ratioBar(day.shortRatio)}`;
          process.stdout.write(
            `  ${day.sessionDate.padEnd(12)}${qty(day.shortVolume).padStart(9)}` +
              `${qty(day.totalVolume).padStart(9)}  ${ratio}${bar}\n`,
          );
        }
        if (report.avgShortRatio !== null) {
          process.stdout.write(
            `  avg short ratio ${pc.bold(`${(report.avgShortRatio * 100).toFixed(1)}%`)} over ${report.days.length} session(s)\n`,
          );
        }
        process.stdout.write(`${pc.dim(report.note)}\n`);
      } finally {
        store.close();
      }
    });
}
