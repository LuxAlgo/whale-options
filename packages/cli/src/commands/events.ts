/*
  `whale events` — query the flight recorder from the terminal: recent flow,
  top-scored windows, or one event's complete story by id.
*/

import { type EventKind, type Side, SqliteFlightRecorder } from "@luxalgo/whale-core";
import type { Command } from "commander";
import pc from "picocolors";
import { applyOverrides, type CommonFlags, loadConfig } from "../config-load.js";
import { renderBreakdown, renderEventLine } from "../render.js";

interface EventsFlags extends CommonFlags {
  underlying?: string;
  kind?: string;
  side?: string;
  minScore?: string;
  limit?: string;
  top?: boolean;
  id?: string;
  ndjson?: boolean;
}

export function registerEvents(program: Command): void {
  program
    .command("events")
    .description("query recorded flow events (or one full story with --id)")
    .option("--config <path>")
    .option("--db <path>")
    .option("--id <eventId>", "print one event's complete story")
    .option("--underlying <sym>")
    .option("--kind <kind>", "sweep|block|split|print")
    .option("--side <side>", "buy|sell|mid|unknown")
    .option("--min-score <n>")
    .option("--min-premium <usd>")
    .option("--limit <n>", "max rows", "30")
    .option("--top", "order by score instead of time")
    .option("--ndjson", "machine-readable output")
    .action(async (flags: EventsFlags) => {
      const { config } = await loadConfig(flags.config);
      applyOverrides(config, flags);
      const store = new SqliteFlightRecorder(config.store.path);

      if (flags.id) {
        const event = store.getEvent(flags.id);
        store.close();
        if (!event) throw new Error(`no event with id ${flags.id}`);
        if (flags.ndjson) {
          process.stdout.write(`${JSON.stringify(event)}\n`);
        } else {
          process.stdout.write(`${renderEventLine(event)}\n${renderBreakdown(event)}\n`);
          process.stdout.write(pc.dim(`legs:\n`));
          for (const leg of event.legs) {
            process.stdout.write(
              pc.dim(
                `  seq ${leg.seq} ts ${leg.ts} ${leg.exchange} ${leg.size}@${leg.price} ` +
                  `nbbo ${leg.nbbo ? `${leg.nbbo.bid}×${leg.nbbo.ask}` : "∅"} cond ${leg.conditions.join("+")}\n`,
              ),
            );
          }
        }
        return;
      }

      const events = store.queryEvents({
        underlying: flags.underlying,
        kind: flags.kind as EventKind | undefined,
        side: flags.side as Side | undefined,
        minScore: flags.minScore ? Number(flags.minScore) : undefined,
        minPremium: flags.minPremium ? Number(flags.minPremium) : undefined,
        limit: Number(flags.limit ?? 30),
        orderBy: flags.top ? "score" : "ts",
      });
      store.close();
      if (events.length === 0) {
        process.stdout.write(pc.dim("no matching events in the flight recorder\n"));
        return;
      }
      for (const event of events) {
        process.stdout.write(
          flags.ndjson
            ? `${JSON.stringify(event)}\n`
            : `${renderEventLine(event)}  ${pc.dim(event.id)}\n`,
        );
      }
    });
}
