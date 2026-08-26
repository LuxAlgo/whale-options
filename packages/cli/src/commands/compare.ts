/*
  `whale compare` — feed cross-validation. Subscribe two adapters to the same
  underlyings for the same window and diff the tapes: prints one vendor
  missed, condition-code disagreements on matched prints, timestamp skew.
  An audit instrument for "is the feed I pay for complete?" — the report's
  notes keep the framing honest: a diff is evidence to investigate with the
  vendor, never an accusation.

  Demo path (zero keys): `--feeds synthetic,synthetic --seed-b <n>` runs two
  synthetic instances with different seeds. Two seeds generate two different
  tapes by construction, so the massive divergence it prints is the
  instrument demonstrably detecting missing prints — not a vendor failing.
*/

import {
  type CompareReport,
  compareFeeds,
  createFeed,
  DEFAULT_UNDERLYINGS,
  type FeedAdapter,
  type FeedId,
  registeredFeeds,
  SyntheticFeed,
} from "@luxalgo/whale-core";
import type { Command } from "commander";
import pc from "picocolors";
import { loadConfig } from "../config-load.js";

interface CompareFlags {
  config?: string;
  feeds?: string;
  tickers?: string;
  duration?: string;
  tolerance?: string;
  seedB?: string;
  json?: boolean;
}

function fmtTs(ts: number): string {
  return new Date(ts).toISOString();
}

function fmtPct(v: number): string {
  return `${v.toFixed(2)}%`;
}

function renderReport(report: CompareReport): string {
  const out: string[] = [];
  const w = report.window;
  out.push(
    pc.bold(`compare: ${report.feeds.a} vs ${report.feeds.b}`) +
      pc.dim(`  window ${Math.round(w.durationMs / 1000)}s from ${fmtTs(w.startedAt)}`),
  );
  out.push("");
  out.push(
    `ticks      a=${report.ticks.a.toLocaleString("en-US")}  b=${report.ticks.b.toLocaleString("en-US")}`,
  );
  out.push(
    `matched    ${report.matched.toLocaleString("en-US")}  ` +
      pc.dim(`(${fmtPct(report.matchedPct.ofA)} of a, ${fmtPct(report.matchedPct.ofB)} of b)`),
  );
  out.push(
    `unique     only-a=${report.onlyA.toLocaleString("en-US")}  only-b=${report.onlyB.toLocaleString("en-US")}`,
  );
  out.push(
    `nbbo       a=${fmtPct(report.nbboCoverage.a * 100)}  b=${fmtPct(report.nbboCoverage.b * 100)} ` +
      pc.dim("of ticks carried a quote"),
  );
  if (report.tsSkewMs) {
    const s = report.tsSkewMs;
    out.push(
      `ts skew    median ${s.median}ms  p95 ${s.p95}ms  min ${s.min}ms  max ${s.max}ms ` +
        pc.dim("(b.ts − a.ts on matched prints)"),
    );
  } else {
    out.push(`ts skew    ${pc.dim("n/a (no matched prints)")}`);
  }

  out.push("");
  const disagreements = report.conditionDisagreements;
  if (disagreements.length === 0) {
    out.push(pc.bold("condition disagreements: ") + pc.dim("none on matched prints"));
  } else {
    out.push(pc.bold(`condition disagreements (${disagreements.length}, capped at 50):`));
    out.push(pc.dim(`  ${"contract".padEnd(22)}${"ts".padEnd(26)}${"a".padEnd(20)}b`));
    for (const d of disagreements.slice(0, 10)) {
      out.push(
        `  ${d.contract.padEnd(22)}${fmtTs(d.ts).padEnd(26)}${d.a.join("+").padEnd(20)}${d.b.join("+")}`,
      );
    }
    if (disagreements.length > 10) {
      out.push(pc.dim(`  … ${disagreements.length - 10} more (use --json for all)`));
    }
  }

  const renderSamples = (
    label: string,
    total: number,
    samples: CompareReport["samples"]["onlyA"],
  ) => {
    out.push("");
    if (total === 0) {
      out.push(pc.bold(`prints only on ${label}: `) + pc.dim("none"));
      return;
    }
    out.push(
      pc.bold(
        `prints only on ${label} (showing ${samples.length} of ${total.toLocaleString("en-US")}):`,
      ),
    );
    for (const s of samples.slice(0, 8)) {
      out.push(
        `  ${s.contract.padEnd(22)}${fmtTs(s.ts)}  ${String(s.size).padStart(5)} @ ${s.price.toFixed(2).padStart(8)}  ex ${s.exchange}`,
      );
    }
    if (samples.length > 8) out.push(pc.dim(`  … ${samples.length - 8} more sampled (use --json)`));
  };
  renderSamples(report.feeds.a, report.onlyA, report.samples.onlyA);
  renderSamples(report.feeds.b, report.onlyB, report.samples.onlyB);

  out.push("");
  out.push(pc.bold("notes, read before quoting any number:"));
  for (const note of report.notes) {
    const loud = note.startsWith("SYNTHETIC DEMO");
    out.push(loud ? pc.bold(pc.yellow(`  · ${note}`)) : pc.dim(`  · ${note}`));
  }
  return `${out.join("\n")}\n`;
}

export function registerCompare(program: Command): void {
  program
    .command("compare")
    .description(
      "cross-validate two feeds over the same window: missed prints, condition disagreements, timestamp skew",
    )
    .option("--config <path>", "config file (default: whale.config.* in cwd)")
    .option("--feeds <a,b>", `two feed adapters to compare: ${registeredFeeds().join(", ")}`)
    .option("--tickers <list>", "comma-separated underlyings both feeds subscribe")
    .option("--duration <sec>", "collection window in seconds", "60")
    .option(
      "--tolerance <ms>",
      "max timestamp gap for two prints to count as the same print",
      "1000",
    )
    .option(
      "--seed-b <n>",
      "demo: second synthetic instance's seed (two tapes diverge by construction)",
    )
    .option("--json", "emit the full CompareReport as JSON")
    .action(async (flags: CompareFlags) => {
      const { config } = await loadConfig(flags.config);
      if (flags.tickers) {
        config.universe.underlyings = flags.tickers
          .split(",")
          .map((t) => t.trim().toUpperCase())
          .filter(Boolean);
      }

      const ids = (flags.feeds ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length !== 2) {
        throw new Error(
          `--feeds needs exactly two comma-separated ids (registered: ${registeredFeeds().join(", ")})`,
        );
      }
      const [idA, idB] = ids as [string, string];

      let seedB: number | undefined;
      if (flags.seedB !== undefined) {
        seedB = Number(flags.seedB);
        if (!Number.isInteger(seedB)) throw new Error("--seed-b must be an integer");
        if (idB !== "synthetic")
          throw new Error("--seed-b only applies when the second feed is synthetic");
      }
      if (idA === idB && !(idA === "synthetic" && seedB !== undefined)) {
        throw new Error(
          "the two feeds must be distinct; comparing a feed to itself proves nothing " +
            "(demo exception: --feeds synthetic,synthetic --seed-b <n> compares two different synthetic tapes)",
        );
      }

      let underlyings = config.universe.underlyings;
      if (underlyings.length === 0) {
        if (idA === "synthetic" || idB === "synthetic") {
          underlyings = DEFAULT_UNDERLYINGS.map((u) => u.symbol);
        } else {
          throw new Error("pass --tickers; both feeds must subscribe the same non-empty universe");
        }
      }

      const durationSec = Number(flags.duration ?? 60);
      if (!Number.isFinite(durationSec) || durationSec <= 0) {
        throw new Error("--duration must be a positive number of seconds");
      }
      const toleranceMs = Number(flags.tolerance ?? 1000);
      if (!Number.isFinite(toleranceMs) || toleranceMs < 0) {
        throw new Error("--tolerance must be a non-negative number of ms");
      }

      const adapterA = createFeed(idA as FeedId, config);
      const adapterB: FeedAdapter =
        seedB !== undefined
          ? new SyntheticFeed({
              seed: seedB,
              regime: config.feed.synthetic.regime,
              eventsPerMinute: config.feed.synthetic.eventsPerMinute,
              pace: "realtime",
            })
          : createFeed(idB as FeedId, config);
      const labelA = idA === idB ? `${idA} (seed ${config.feed.synthetic.seed})` : idA;
      const labelB = idA === idB ? `${idB} (seed ${seedB})` : idB;

      const controller = new AbortController();
      let interrupts = 0;
      process.on("SIGINT", () => {
        interrupts++;
        if (interrupts === 1) {
          process.stderr.write(pc.dim("\nstopping: diffing what was collected…\n"));
          controller.abort();
        } else {
          process.exit(130);
        }
      });

      if (!flags.json) {
        process.stderr.write(
          pc.dim(
            `comparing ${labelA} vs ${labelB} on ${underlyings.join(",")} for ${durationSec}s ` +
              `(tolerance ${toleranceMs}ms)\n`,
          ),
        );
      }

      const counts = new Map<string, number>();
      const report = await compareFeeds({
        a: { id: labelA, adapter: adapterA },
        b: { id: labelB, adapter: adapterB },
        underlyings,
        durationMs: durationSec * 1000,
        matchToleranceMs: toleranceMs,
        signal: controller.signal,
        onProgress: (p) => {
          if (!process.stderr.isTTY) return;
          counts.set(p.feed, p.ticks);
          const line = [...counts.entries()].map(([f, n]) => `${f}=${n}`).join("  ");
          process.stderr.write(`\r${pc.dim(`collecting… ${line}`)}`);
        },
      });
      if (process.stderr.isTTY && counts.size > 0) process.stderr.write("\n");

      if (seedB !== undefined && idA === idB) {
        report.notes.push(
          "SYNTHETIC DEMO: two seeds generate two different tapes by construction; the divergence above is the instrument detecting missing prints, not a vendor failing",
        );
      }

      process.stdout.write(
        flags.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report),
      );

      await adapterA.close?.();
      await adapterB.close?.();
    });
}
