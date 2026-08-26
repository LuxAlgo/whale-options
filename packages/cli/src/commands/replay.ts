/*
  `whale replay` — re-run any window of recorded tape through the engine
  under the *current* config. Because ticks are self-contained and the engine
  is pure, the output is exactly what a live run would have produced; --diff
  compares against what the flight recorder actually stored at the time
  (useful after changing weights/thresholds: see precisely what would have
  changed).
*/

import {
  Engine,
  type FlightRecorder,
  type FlowEvent,
  MemoryFlightRecorder,
  ReplayFeed,
  runEngine,
  SqliteFlightRecorder,
  sessionDateOf,
} from "@luxalgo/whale-core";
import type { Command } from "commander";
import pc from "picocolors";
import { applyOverrides, type CommonFlags, loadConfig } from "../config-load.js";
import { renderEvent } from "../render.js";

interface ReplayFlags extends CommonFlags {
  file?: string;
  from?: string;
  to?: string;
  underlying?: string;
  diff?: boolean;
  ndjson?: boolean;
  verbose?: boolean;
  quiet?: boolean;
}

function parseTs(value: string, name: string): number {
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && value.trim() !== "") return asNumber;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`--${name} must be epoch ms or an ISO datetime`);
  return parsed;
}

export function registerReplay(program: Command): void {
  program
    .command("replay")
    .description("re-run a tape file or a flight-recorder window through the current config")
    .option("--config <path>", "config file (default: whale.config.* in cwd)")
    .option("--file <tape>", "NDJSON tape file (from --record); otherwise reads the store")
    .option("--from <ts>", "window start (ISO datetime or epoch ms)")
    .option("--to <ts>", "window end (ISO datetime or epoch ms)")
    .option("--underlying <sym>", "restrict to one underlying")
    .option("--db <path>", "flight recorder path")
    .option("--min-premium <usd>", "emission floor in premium dollars")
    .option("--diff", "compare replayed events against what the store recorded")
    .option("--ndjson", "emit events as NDJSON")
    .option("--verbose", "print reasons and score breakdowns")
    .option("--quiet", "only print the summary")
    .action(async (flags: ReplayFlags) => {
      const { config } = await loadConfig(flags.config);
      applyOverrides(config, flags);

      const events: FlowEvent[] = [];
      const emit = (event: FlowEvent) => {
        events.push(event);
        if (flags.quiet) return;
        const line = flags.ndjson
          ? JSON.stringify(event)
          : renderEvent(event, flags.verbose ?? false);
        process.stdout.write(`${line}\n`);
      };

      let store: FlightRecorder | null = null;

      if (flags.file) {
        const adapter = new ReplayFeed(flags.file);
        const scratch = new MemoryFlightRecorder();
        await runEngine({ config, adapter, store: scratch, replayMode: true, onEvent: emit });
      } else {
        if (!flags.from || !flags.to) {
          throw new Error("without --file, both --from and --to are required");
        }
        const from = parseTs(flags.from, "from");
        const to = parseTs(flags.to, "to");
        store = new SqliteFlightRecorder(config.store.path);
        const baselines = store.loadBaselineState(config.score.lookbackDays, sessionDateOf(from));
        const engine = new Engine(config, baselines);
        let ticks = 0;
        for (const tick of store.iterateTicks({ from, to, underlying: flags.underlying })) {
          ticks++;
          for (const e of engine.push(tick)) emit(e);
        }
        for (const e of engine.flush()) emit(e);
        process.stderr.write(pc.dim(`replayed ${ticks.toLocaleString("en-US")} stored ticks\n`));

        if (flags.diff) {
          const stored = store.queryEvents({
            from,
            to,
            underlying: flags.underlying,
            limit: 1000,
            orderBy: "ts",
          });
          const storedById = new Map(stored.map((e) => [e.id, e]));
          const replayedById = new Map(events.map((e) => [e.id, e]));
          const added = events.filter((e) => !storedById.has(e.id));
          const removed = stored.filter((e) => !replayedById.has(e.id));
          const scoreChanged = events
            .filter((e) => storedById.has(e.id))
            .map((e) => ({ replayed: e, stored: storedById.get(e.id)! }))
            .filter((p) => p.replayed.score.total !== p.stored.score.total);
          process.stderr.write(
            `${pc.bold("diff vs store:")} ${added.length} added, ${removed.length} removed, ` +
              `${scoreChanged.length} score-changed (of ${stored.length} stored)\n`,
          );
          for (const e of added.slice(0, 5)) {
            process.stderr.write(pc.green(`  + ${e.kind} ${e.contract} score ${e.score.total}\n`));
          }
          for (const e of removed.slice(0, 5)) {
            process.stderr.write(pc.red(`  - ${e.kind} ${e.contract} score ${e.score.total}\n`));
          }
          for (const p of scoreChanged.slice(0, 5)) {
            process.stderr.write(
              pc.yellow(
                `  ~ ${p.replayed.contract} ${p.stored.score.total} → ${p.replayed.score.total}\n`,
              ),
            );
          }
        }
      }

      process.stderr.write(pc.dim(`replay produced ${events.length} events\n`));
      store?.close();
    });
}
