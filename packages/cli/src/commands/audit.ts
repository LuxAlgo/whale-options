/*
  `whale audit` — calibrate recorded whale scores against forward moves of
  the underlying, computed on the user's own flight recorder. A measuring
  instrument, not a performance claim: the caveats block prints every time,
  small buckets are flagged as noise, and synthetic tape is called out loudly.
*/

import {
  AUDIT_HORIZONS,
  type AuditHorizon,
  type CalibrationBucket,
  type CalibrationReport,
  calibrate,
  SqliteFlightRecorder,
} from "@luxalgo/whale-core";
import type { Command } from "commander";
import pc from "picocolors";
import { applyOverrides, type CommonFlags, loadConfig } from "../config-load.js";

interface AuditFlags extends CommonFlags {
  horizon?: string;
  from?: string;
  to?: string;
  underlying?: string;
  excludeColdStart?: boolean;
  json?: boolean;
}

function parseTs(value: string, name: string): number {
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && value.trim() !== "") return asNumber;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`--${name} must be epoch ms or an ISO datetime`);
  return parsed;
}

function pct(v: number | null, decimals = 2): string {
  if (v === null) return "n/a";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(decimals)}%`;
}

function renderTable(title: string, rows: CalibrationBucket[], baseAligned: number | null): string {
  const lines: string[] = [];
  lines.push(pc.bold(title));
  const header = [
    "bucket".padEnd(8),
    "n".padStart(6),
    "median fwd".padStart(11),
    "mean fwd".padStart(10),
    "aligned".padStart(8),
    "vs base".padStart(8),
  ];
  lines.push(pc.dim(header.join("  ")));
  for (const b of rows) {
    const delta =
      b.alignedPct === null || baseAligned === null
        ? "n/a"
        : `${b.alignedPct - baseAligned >= 0 ? "+" : ""}${(b.alignedPct - baseAligned).toFixed(1)}pt`;
    const cells = [
      b.label.padEnd(8),
      String(b.n).padStart(6),
      pct(b.medianFwdReturnPct, 3).padStart(11),
      pct(b.meanFwdReturnPct, 3).padStart(10),
      (b.alignedPct === null ? "n/a" : `${b.alignedPct.toFixed(1)}%`).padStart(8),
      delta.padStart(8),
    ];
    const line = cells.join("  ") + (b.smallN ? pc.yellow("  (n<30, noise)") : "");
    lines.push(b.smallN ? pc.dim(line) : line);
  }
  if (rows.length === 0) lines.push(pc.dim("  (no events with an outcome)"));
  return lines.join("\n");
}

function renderReport(report: CalibrationReport): string {
  const out: string[] = [];
  const from = new Date(report.window.from).toISOString();
  const to = new Date(report.window.to).toISOString();
  out.push(pc.bold(`calibration: horizon ${report.horizon}`) + pc.dim(`  window ${from} → ${to}`));
  out.push(
    pc.dim(
      `${report.eventsConsidered} events considered, ${report.eventsWithOutcome} with an outcome; ` +
        `excluded: ${report.excluded.mid} mid, ${report.excluded.unknown} unknown side, ` +
        `${report.excluded.noPriceData} no price data`,
    ),
  );
  out.push("");
  out.push(renderTable("by score bucket", report.buckets, report.baseRate.alignedPct));
  out.push("");
  out.push(
    pc.dim(
      `base rate (all events with an outcome, same window): aligned ` +
        `${report.baseRate.alignedPct === null ? "n/a" : `${report.baseRate.alignedPct.toFixed(1)}%`}, ` +
        `median fwd ${pct(report.baseRate.medianFwdReturnPct, 3)}; coin flip is 50%`,
    ),
  );
  out.push("");
  out.push(renderTable("by kind", report.byKind, report.baseRate.alignedPct));
  out.push("");
  out.push(renderTable("by side", report.bySide, report.baseRate.alignedPct));
  out.push("");
  out.push(pc.bold("caveats, read before quoting any number:"));
  for (const caveat of report.caveats) {
    const loud = caveat.startsWith("SYNTHETIC TAPE");
    out.push(loud ? pc.bold(pc.yellow(`  · ${caveat}`)) : pc.dim(`  · ${caveat}`));
  }
  return `${out.join("\n")}\n`;
}

export function registerAudit(program: Command): void {
  program
    .command("audit")
    .description(
      "calibrate recorded whale scores against forward underlying moves (measurement, not advice)",
    )
    .option("--config <path>", "config file (default: whale.config.* in cwd)")
    .option("--db <path>", "flight recorder path")
    .option("--horizon <h>", `forward horizon: ${AUDIT_HORIZONS.join("|")}`, "1h")
    .option("--from <ts>", "window start (ISO datetime or epoch ms; default: first recorded tick)")
    .option("--to <ts>", "window end (ISO datetime or epoch ms; default: last recorded tick)")
    .option("--underlying <sym>", "restrict to one underlying")
    .option("--exclude-cold-start", "skip events scored before baselines had enough history")
    .option("--json", "emit the full CalibrationReport as JSON (caveats included)")
    .action(async (flags: AuditFlags) => {
      const horizon = flags.horizon ?? "1h";
      if (!AUDIT_HORIZONS.includes(horizon as AuditHorizon)) {
        throw new Error(`--horizon must be one of ${AUDIT_HORIZONS.join(", ")}`);
      }
      const { config } = await loadConfig(flags.config);
      applyOverrides(config, flags);
      const store = new SqliteFlightRecorder(config.store.path);
      try {
        const status = store.status();
        const from = flags.from ? parseTs(flags.from, "from") : status.firstTickTs;
        const to = flags.to ? parseTs(flags.to, "to") : (status.lastTickTs ?? status.lastEventTs);
        if (from === null || from === undefined || to === null || to === undefined) {
          throw new Error(
            "nothing recorded yet: the flight recorder has no ticks (pass --from/--to to override)",
          );
        }
        const report = await calibrate({
          store,
          from,
          to,
          horizon: horizon as AuditHorizon,
          underlying: flags.underlying,
          excludeColdStart: flags.excludeColdStart,
        });
        process.stdout.write(
          flags.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report),
        );
      } finally {
        store.close();
      }
    });
}
