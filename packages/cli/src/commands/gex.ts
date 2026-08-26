/*
  `whale gex <underlying>` — the per-strike gamma-exposure ladder with the
  zero-gamma level, sign convention stated. Reads the freshest chain: the
  live feed when available, otherwise the last snapshot in the flight
  recorder.
*/

import {
  type ChainSnapshot,
  computeGex,
  createFeed,
  type GexLadder,
  SqliteFlightRecorder,
} from "@luxalgo/whale-core";
import type { Command } from "commander";
import pc from "picocolors";
import { applyOverrides, type CommonFlags, loadConfig } from "../config-load.js";

interface GexFlags extends CommonFlags {
  expiry?: string;
  json?: boolean;
}

function money(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function renderLadder(gex: GexLadder): string {
  const lines: string[] = [];
  lines.push(
    `${pc.bold(gex.underlying)} spot ${gex.spot}  ·  total GEX ${pc.bold(money(gex.totalGex))} per 1% move  ·  ` +
      (gex.zeroGamma
        ? `zero-gamma ~${pc.bold(String(gex.zeroGamma.level))}`
        : "no zero-gamma crossing in scan"),
  );
  lines.push(pc.dim(`convention ${gex.convention}: ${gex.conventionNote}`));
  lines.push(pc.dim(`expiries: ${gex.expiriesIncluded.join(", ")}`));
  const maxAbs = Math.max(1, ...gex.perStrike.map((r) => Math.abs(r.netGex)));
  for (const row of gex.perStrike) {
    const width = Math.round((Math.abs(row.netGex) / maxAbs) * 30);
    const bar = row.netGex >= 0 ? pc.green("█".repeat(width)) : pc.red("█".repeat(width));
    const marker =
      gex.zeroGamma && Math.abs(row.strike - gex.zeroGamma.level) < 1e-9 ? " ← zero-gamma" : "";
    const spotMark = row.strike <= gex.spot ? " " : "";
    lines.push(
      `  ${String(row.strike).padStart(8)} ${money(row.netGex).padStart(9)} ${bar}${marker}${spotMark}`,
    );
  }
  if (gex.skippedContracts > 0) {
    lines.push(pc.dim(`(${gex.skippedContracts} contracts skipped: no derivable gamma)`));
  }
  return `${lines.join("\n")}\n`;
}

export function registerGex(program: Command): void {
  program
    .command("gex <underlying>")
    .description("per-strike gamma exposure ladder + zero-gamma level (convention stated)")
    .option("--config <path>")
    .option("--feed <id>", "pull a fresh chain from this feed instead of the store")
    .option("--db <path>")
    .option("--expiry <date>", "restrict to one expiry (YYYY-MM-DD)")
    .option("--json", "machine-readable output")
    .action(async (underlying: string, flags: GexFlags) => {
      const { config } = await loadConfig(flags.config);
      applyOverrides(config, flags);

      let snapshot: ChainSnapshot | null = null;
      if (flags.feed) {
        const adapter = createFeed(config.feed.id, config);
        snapshot = await adapter.getChainSnapshot(underlying.toUpperCase());
        await adapter.close?.();
      } else {
        const store = new SqliteFlightRecorder(config.store.path);
        snapshot = store.getChainSnapshot(underlying.toUpperCase());
        store.close();
        if (!snapshot) {
          const adapter = createFeed(config.feed.id, config);
          snapshot = await adapter.getChainSnapshot(underlying.toUpperCase());
          await adapter.close?.();
        }
      }
      if (!snapshot) {
        throw new Error(
          `no chain for ${underlying.toUpperCase()}; run \`whale run\` with it in universe.underlyings, or pass --feed`,
        );
      }

      const ladder = computeGex(snapshot, {
        r: config.greeks.r,
        q: config.greeks.qByUnderlying[snapshot.underlying] ?? config.greeks.q,
        convention: config.greeks.gexConvention,
        expiry: flags.expiry,
      });
      if (!ladder) throw new Error("chain snapshot has no usable contracts (no OI/IV/greeks)");

      process.stdout.write(
        flags.json ? `${JSON.stringify(ladder, null, 2)}\n` : renderLadder(ladder),
      );
    });
}
