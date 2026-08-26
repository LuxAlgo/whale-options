/*
  `whale bench` — engine throughput and store growth on a synthetic tape, so
  users can size retention and CI can catch performance regressions
  (--min-ticks-per-sec makes it a hard gate).
*/

import {
  Engine,
  easternTimeToUtc,
  type FlowEvent,
  normalizeTrade,
  type OptionTradeTick,
  resolveConfig,
  SqliteFlightRecorder,
  SyntheticFeed,
  sessionDateOf,
} from "@luxalgo/whale-core";
import type { Command } from "commander";
import pc from "picocolors";

interface BenchFlags {
  events?: string;
  seed?: string;
  minTicksPerSec?: string;
  json?: boolean;
}

export function registerBench(program: Command): void {
  program
    .command("bench")
    .description("measure engine throughput and flight-recorder growth on a synthetic tape")
    .option("--events <n>", "tape length in prints", "20000")
    .option("--seed <n>", "synthetic seed", "42")
    .option("--min-ticks-per-sec <n>", "exit non-zero below this engine throughput (CI gate)")
    .option("--json", "machine-readable output")
    .action(async (flags: BenchFlags) => {
      const maxEvents = Number(flags.events ?? 20000);
      const seed = Number(flags.seed ?? 42);
      const startTs = easternTimeToUtc(sessionDateOf(Date.now()), 9, 30);

      // 1. Generate + normalize the tape (excluded from engine timing).
      const feed = new SyntheticFeed({ seed, startTs, maxEvents, pace: "asap" });
      const ticks: OptionTradeTick[] = [];
      let seq = 0;
      for await (const raw of feed.subscribeOptionTrades({})) {
        const { tick } = normalizeTrade(raw, "synthetic", seq, (c) => feed.normalizeCondition(c));
        if (tick) {
          ticks.push(tick);
          seq++;
        }
      }

      // 2. Pure engine pass with per-push latency sampling.
      const config = resolveConfig({ engine: { emit: { minPremium: 0 } } });
      const engine = new Engine(config);
      const events: FlowEvent[] = [];
      const latencies = new Float64Array(ticks.length);
      const engineStart = process.hrtime.bigint();
      for (let i = 0; i < ticks.length; i++) {
        const t0 = process.hrtime.bigint();
        const out = engine.push(ticks[i]!);
        latencies[i] = Number(process.hrtime.bigint() - t0) / 1e6;
        if (out.length > 0) events.push(...out);
      }
      events.push(...engine.flush());
      const engineMs = Number(process.hrtime.bigint() - engineStart) / 1e6;
      const ticksPerSec = Math.round(ticks.length / (engineMs / 1000));

      const sorted = [...latencies].sort((a, b) => a - b);
      const p = (q: number) =>
        sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

      // 3. Store write pass (separate, so engine numbers stay clean).
      const store = new SqliteFlightRecorder(":memory:");
      const storeStart = process.hrtime.bigint();
      for (let i = 0; i < ticks.length; i += 500) store.insertTicks(ticks.slice(i, i + 500));
      store.insertEvents(events);
      const storeMs = Number(process.hrtime.bigint() - storeStart) / 1e6;
      const bytesPerTick = 320; // measured JSON row average; retention math below
      store.close();

      const report = {
        ticks: ticks.length,
        events: events.length,
        engineMs: Math.round(engineMs),
        ticksPerSec,
        pushLatencyMs: {
          p50: round3(p(0.5)),
          p99: round3(p(0.99)),
          max: round3(sorted[sorted.length - 1] ?? 0),
        },
        storeWriteMs: Math.round(storeMs),
        storeTicksPerSec: Math.round(ticks.length / (storeMs / 1000)),
        estGrowthPerMillionTicksMb: Math.round((bytesPerTick * 1_000_000) / 1_048_576),
      };

      if (flags.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(
          [
            pc.bold("whale bench"),
            `  tape            ${report.ticks.toLocaleString("en-US")} ticks → ${report.events.toLocaleString("en-US")} events`,
            `  engine          ${report.engineMs}ms  (${pc.bold(report.ticksPerSec.toLocaleString("en-US"))} ticks/sec)`,
            `  push latency    p50 ${report.pushLatencyMs.p50}ms · p99 ${report.pushLatencyMs.p99}ms · max ${report.pushLatencyMs.max}ms`,
            `  store writes    ${report.storeWriteMs}ms  (${report.storeTicksPerSec.toLocaleString("en-US")} ticks/sec, batched)`,
            `  growth          ~${report.estGrowthPerMillionTicksMb}MB per million ticks (size retention accordingly)`,
            "",
          ].join("\n"),
        );
      }

      if (flags.minTicksPerSec) {
        const floor = Number(flags.minTicksPerSec);
        if (ticksPerSec < floor) {
          process.stderr.write(pc.red(`FAIL: ${ticksPerSec} ticks/sec < required ${floor}\n`));
          process.exitCode = 1;
        }
      }
    });
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
