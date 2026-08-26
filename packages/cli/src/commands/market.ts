/*
  `whale market` — market-structure analytics from the flight recorder's
  daily-history layer: session-to-session OI deltas, max pain per expiry,
  IV rank/percentile, and the net-premium-flow leaderboard. All read-only
  over the store; every output states its window and its caveats.
*/

import {
  ivRank,
  type MaxPainResult,
  maxPain,
  type NetFlowReport,
  netFlowReport,
  type OiDeltasResult,
  oiDeltas,
  SqliteFlightRecorder,
} from "@luxalgo/whale-core";
import type { Command } from "commander";
import pc from "picocolors";
import { applyOverrides, type CommonFlags, loadConfig } from "../config-load.js";

interface MarketFlags extends CommonFlags {
  json?: boolean;
  sessions?: string;
  top?: string;
  minOi?: string;
  expiry?: string;
  window?: string;
}

function money(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function signed(v: number, text = String(v)): string {
  if (v > 0) return pc.green(`+${text}`);
  if (v < 0) return pc.red(text);
  return pc.dim(text);
}

async function withStore<T>(
  flags: MarketFlags,
  fn: (store: SqliteFlightRecorder) => T,
): Promise<T> {
  const { config } = await loadConfig(flags.config);
  applyOverrides(config, flags);
  const store = new SqliteFlightRecorder(config.store.path);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function renderOi(result: OiDeltasResult): string {
  const lines: string[] = [];
  if (result.note !== null) {
    lines.push(`${pc.bold(result.underlying)}  ${pc.yellow(result.note)}`);
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    `${pc.bold(result.underlying)} open-interest change ${result.fromDate} → ${result.toDate}` +
      pc.dim(`  (${result.sessionsAvailable} sessions recorded)`),
  );
  lines.push(pc.dim("  contract              prev → now        Δ        Δ%"));
  for (const c of result.contracts) {
    const pct = c.deltaPct === null ? pc.dim("new") : signed(c.deltaPct, `${c.deltaPct}%`);
    const flag = c.newContract ? pc.yellow(" NEW") : "";
    lines.push(
      `  ${c.contract.padEnd(21)} ${String(c.prevOi ?? "∅").padStart(7)} → ${String(c.currOi).padStart(7)} ` +
        `${signed(c.deltaOi).padStart(8)} ${String(pct).padStart(8)}${flag}`,
    );
  }
  lines.push(pc.dim("  by strike (ΔOI):"));
  for (const s of result.byStrike.slice(0, 8)) {
    lines.push(
      `    ${String(s.strike).padStart(8)}  ${signed(s.deltaOi)}  ${pc.dim(`now ${s.currOi}`)}`,
    );
  }
  lines.push(pc.dim("  by expiry (ΔOI):"));
  for (const e of result.byExpiry.slice(0, 8)) {
    lines.push(`    ${e.expiry}  ${signed(e.deltaOi)}  ${pc.dim(`now ${e.currOi}`)}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderMaxPain(result: MaxPainResult): string {
  const lines: string[] = [];
  if (result.expiries.length === 0) {
    lines.push(`${pc.bold(result.underlying)}  ${pc.yellow(result.note)}`);
    return `${lines.join("\n")}\n`;
  }
  const asOf =
    result.source === "chain-snapshot"
      ? `chain snapshot ${new Date(result.asOfTs ?? 0).toISOString()}`
      : `contract_daily ${result.sessionDate}`;
  lines.push(
    `${pc.bold(result.underlying)} max pain` +
      (result.spot !== null ? `  ·  spot ${result.spot}` : "") +
      pc.dim(`  ·  source: ${asOf}`),
  );
  for (const e of result.expiries) {
    lines.push(
      `  ${e.expiry}  strike ${pc.bold(String(e.maxPainStrike))}  payout-at-strike ${money(e.totalPayoutAtStrike)}` +
        pc.dim(`  callOI ${e.callOi}  putOI ${e.putOi}  (${e.strikesEvaluated} strikes)`),
    );
  }
  lines.push(pc.dim(`  note: ${result.note}`));
  return `${lines.join("\n")}\n`;
}

function renderNetFlow(report: NetFlowReport): string {
  const lines: string[] = [];
  if (report.rows.length === 0) {
    lines.push(pc.yellow(report.note));
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    pc.bold("net premium flow") +
      pc.dim(
        `  ${new Date(report.from).toISOString()} → ${new Date(report.to).toISOString()}` +
          `  (${report.totals.underlyings} underlyings, ${report.totals.events} events)`,
      ),
  );
  lines.push(pc.dim("  underlying  events   call net    put net   net premium"));
  for (const r of report.rows) {
    lines.push(
      `  ${r.underlying.padEnd(10)} ${String(r.events).padStart(6)} ` +
        `${String(signed(r.callNet, money(r.callNet))).padStart(10)} ` +
        `${String(signed(r.putNet, money(r.putNet))).padStart(10)} ` +
        `${String(signed(r.netPremium, money(r.netPremium))).padStart(12)}`,
    );
  }
  const t = report.totals;
  lines.push(
    pc.bold(
      `  ${"TOTAL".padEnd(10)} ${String(t.events).padStart(6)} ` +
        `${String(signed(t.callNet, money(t.callNet))).padStart(10)} ` +
        `${String(signed(t.putNet, money(t.putNet))).padStart(10)} ` +
        `${String(signed(t.netPremium, money(t.netPremium))).padStart(12)}`,
    ),
  );
  lines.push(pc.dim(`  note: ${report.note}`));
  return `${lines.join("\n")}\n`;
}

export function registerMarket(program: Command): void {
  const market = program
    .command("market")
    .description("market-structure analytics: OI deltas, max pain, IV rank, net flow");

  market
    .command("oi <underlying>")
    .description("session-to-session open-interest deltas per contract/strike/expiry")
    .option("--config <path>")
    .option("--db <path>")
    .option("--sessions <n>", "compare across the last N recorded sessions", "2")
    .option("--top <n>", "max contract rows", "20")
    .option("--min-oi <n>", "ignore contracts below this OI on both sessions")
    .option("--json", "machine-readable output")
    .action(async (underlying: string, flags: MarketFlags) => {
      const result = await withStore(flags, (store) =>
        oiDeltas(store, underlying, {
          sessions: Number(flags.sessions ?? 2),
          top: Number(flags.top ?? 20),
          minOi: flags.minOi !== undefined ? Number(flags.minOi) : undefined,
        }),
      );
      process.stdout.write(flags.json ? `${JSON.stringify(result, null, 2)}\n` : renderOi(result));
    });

  market
    .command("maxpain <underlying>")
    .description("per-expiry max-pain strike (a static from current OI, not a prediction)")
    .option("--config <path>")
    .option("--db <path>")
    .option("--expiry <date>", "restrict to one expiry (YYYY-MM-DD)")
    .option("--json", "machine-readable output")
    .action(async (underlying: string, flags: MarketFlags) => {
      const result = await withStore(flags, (store) => maxPain(store, underlying, flags.expiry));
      process.stdout.write(
        flags.json ? `${JSON.stringify(result, null, 2)}\n` : renderMaxPain(result),
      );
    });

  market
    .command("ivrank <underlying>")
    .description("IV rank/percentile over recorded ATM-IV history (window stated)")
    .option("--config <path>")
    .option("--db <path>")
    .option("--json", "machine-readable output")
    .action(async (underlying: string, flags: MarketFlags) => {
      const result = await withStore(flags, (store) => ivRank(store, underlying));
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      if (result.currentIv === null) {
        process.stdout.write(`${pc.bold(result.underlying)}  ${pc.yellow(result.note)}\n`);
        return;
      }
      process.stdout.write(
        `${pc.bold(result.underlying)} ATM IV ${result.currentIv}` +
          `  ·  rank ${result.ivRank === null ? "∅" : pc.bold(String(result.ivRank))}` +
          `  ·  percentile ${result.ivPercentile}` +
          `  ·  min ${result.minIv} / max ${result.maxIv}` +
          pc.dim(`  (${result.firstDate} → ${result.lastDate})`) +
          `\n${pc.dim(`  note: ${result.note}`)}\n`,
      );
    });

  market
    .command("netflow")
    .description("net premium flow leaderboard per underlying (emitted events only)")
    .option("--config <path>")
    .option("--db <path>")
    .option("--window <minutes>", "look back this many minutes from the last recorded event", "390")
    .option("--top <n>", "max leaderboard rows", "15")
    .option("--json", "machine-readable output")
    .action(async (flags: MarketFlags) => {
      const report = await withStore(flags, (store) => {
        const status = store.status();
        const to = status.lastEventTs ?? status.lastTickTs ?? Date.now();
        const from = to - Number(flags.window ?? 390) * 60_000;
        return netFlowReport(store, from, to, { top: Number(flags.top ?? 15) });
      });
      process.stdout.write(
        flags.json ? `${JSON.stringify(report, null, 2)}\n` : renderNetFlow(report),
      );
    });
}
