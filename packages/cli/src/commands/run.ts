/*
  `whale run` — the 60-second demo and the daily driver. Zero-key path:
  `npx @luxalgo/whale-cli run --feed synthetic` streams classified, scored
  events immediately. With a real feed configured it does the same against
  the user's own entitlement, records to the flight recorder, serves the
  dashboard API, fires alert rules, and (with --record) writes a tape.
*/

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  createFeed,
  createWhaleServer,
  DEFAULT_UNDERLYINGS,
  type FlightRecorder,
  MemoryFlightRecorder,
  registeredFeeds,
  runEngine,
  SqliteFlightRecorder,
  TapeWriter,
  type WhaleServer,
} from "@luxalgo/whale-core";
import type { Command } from "commander";
import pc from "picocolors";
import { applyOverrides, type CommonFlags, loadConfig } from "../config-load.js";
import { renderEvent } from "../render.js";

/**
 * Locate the built dashboard (@luxalgo/whale-dashboard/dist) at runtime.
 * It's a normal workspace/npm dependency, so resolution works both from the
 * repo and from an installed CLI; when it's absent (partial install, API-only
 * builds) we degrade silently to serving just the API.
 */
function resolveDashboardDist(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("@luxalgo/whale-dashboard/package.json");
    const dist = join(dirname(pkg), "dist");
    return existsSync(join(dist, "index.html")) ? dist : undefined;
  } catch {
    return undefined;
  }
}

interface RunFlags extends CommonFlags {
  ndjson?: boolean;
  verbose?: boolean;
  record?: string;
  serve?: boolean;
  quiet?: boolean;
}

export function registerRun(program: Command): void {
  program
    .command("run")
    .description("stream, classify, score, record, and alert on live options flow")
    .option("--config <path>", "config file (default: whale.config.* in cwd)")
    .option("--feed <id>", `feed adapter: ${registeredFeeds().join(", ")}`)
    .option("--tickers <list>", "comma-separated underlyings to subscribe")
    .option("--db <path>", "flight recorder path (':memory:' for none)")
    .option("--min-premium <usd>", "emission floor in premium dollars")
    .option("--seed <n>", "synthetic feed seed")
    .option("--regime <name>", "synthetic regime: mixed|quiet|sweep-clusters|earnings-ramp")
    .option("--port <n>", "dashboard/API port")
    .option("--record <file>", "also write every tick to an NDJSON tape")
    .option("--ndjson", "emit events as NDJSON instead of pretty lines")
    .option("--verbose", "print the reasons trail and score breakdown per event")
    .option("--quiet", "suppress per-event output (alerts and recorder still run)")
    .option("--no-serve", "do not start the local HTTP/WS server")
    .action(async (flags: RunFlags) => {
      const { config, path } = await loadConfig(flags.config);
      applyOverrides(config, flags);

      // Zero-key demo parity: chain snapshots (vol/OI, GEX, the dashboard's
      // ladder picker) are only pulled for universe.underlyings, so an empty
      // universe on the synthetic feed means the feed's built-in symbols.
      // The trade stream is identical either way — the filter matches all.
      if (config.feed.id === "synthetic" && config.universe.underlyings.length === 0) {
        config.universe.underlyings = DEFAULT_UNDERLYINGS.map((u) => u.symbol);
      }

      const store: FlightRecorder =
        config.store.path === ":memory:" || config.store.driver === "memory"
          ? new MemoryFlightRecorder()
          : new SqliteFlightRecorder(config.store.path);

      const adapter = createFeed(config.feed.id, config);
      const record = flags.record ? new TapeWriter(flags.record) : undefined;

      let server: WhaleServer | null = null;
      if (flags.serve !== false && config.server.enabled) {
        const staticDir = resolveDashboardDist();
        server = createWhaleServer({
          store,
          config,
          staticDir,
          statusExtras: () => ({
            feed: config.feed.id,
            universe: config.universe.underlyings,
            configPath: path,
          }),
        });
        try {
          const addr = await server.listen();
          if (!flags.ndjson) {
            process.stderr.write(pc.dim(`api+ws listening on http://${addr.host}:${addr.port}\n`));
            if (staticDir) {
              process.stderr.write(`dashboard: ${pc.cyan(`http://${addr.host}:${addr.port}`)}\n`);
            }
          }
        } catch (err) {
          server = null;
          process.stderr.write(
            pc.yellow(`server disabled: ${err instanceof Error ? err.message : String(err)}\n`),
          );
        }
      }

      if (!flags.ndjson && !flags.quiet) {
        process.stderr.write(
          pc.dim(
            `feed=${config.feed.id} universe=${config.universe.underlyings.join(",") || "(feed default)"} ` +
              `min-premium=$${config.engine.emit.minPremium.toLocaleString("en-US")} db=${config.store.path}\n`,
          ),
        );
      }

      const controller = new AbortController();
      let interrupts = 0;
      process.on("SIGINT", () => {
        interrupts++;
        if (interrupts === 1) {
          process.stderr.write(pc.dim("\nshutting down: flushing open windows and buffers…\n"));
          controller.abort();
        } else {
          process.exit(130);
        }
      });

      const summary = await runEngine({
        config,
        adapter,
        store,
        record,
        signal: controller.signal,
        onFlowBuckets: (rows) => server?.broadcastFlow(rows),
        onEvent: (event) => {
          server?.broadcast(event);
          if (flags.quiet) return;
          const line = flags.ndjson
            ? JSON.stringify(event)
            : renderEvent(event, flags.verbose ?? false);
          process.stdout.write(`${line}\n`);
        },
      });

      const s = summary.stats;
      process.stderr.write(
        pc.dim(
          `\n${s.ticksSeen.toLocaleString("en-US")} ticks → ${s.eventsEmitted.toLocaleString("en-US")} events ` +
            `(${s.sweepsResolved} sweeps, ${s.eventsSuppressed} below premium floor, ` +
            `${summary.droppedTicks} unparseable, ${summary.alertsMatched} alerts)\n`,
        ),
      );

      await server?.close();
      await adapter.close?.();
      store.close();
    });
}
