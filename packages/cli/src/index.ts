/*
  whale — the options-flow engine CLI.
  Zero-key demo: `whale run --feed synthetic`.
*/
import { Command } from "commander";
import pc from "picocolors";
import { registerAudit } from "./commands/audit.js";
import { registerBackfill } from "./commands/backfill.js";
import { registerBench } from "./commands/bench.js";
import { registerCompare } from "./commands/compare.js";
import { registerContext } from "./commands/context.js";
import { registerEvents } from "./commands/events.js";
import { registerGex } from "./commands/gex.js";
import { registerMarket } from "./commands/market.js";
import { registerReplay } from "./commands/replay.js";
import { registerRules } from "./commands/rules.js";
import { registerRun } from "./commands/run.js";

const program = new Command();
program
  .name("whale")
  .description(
    "Open-source options-flow engine: classify every print (sweep/block/split), score it with a fully transparent breakdown, compute GEX, fire alerts, and record everything in a replayable flight recorder. Bring your own market-data feed, or start with the built-in synthetic tape, zero keys required.",
  )
  .version("0.1.0");

registerRun(program);
registerBackfill(program);
registerReplay(program);
registerCompare(program);
registerBench(program);
registerRules(program);
registerGex(program);
registerEvents(program);
registerMarket(program);
registerAudit(program);
registerContext(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(pc.red(`error: ${err instanceof Error ? err.message : String(err)}\n`));
  process.exitCode = 1;
});
