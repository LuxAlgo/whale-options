/*
  `whale rules` — alert rule CRUD against the flight recorder. Rules declared
  in whale.config.ts are re-seeded on every run (source: config); rules added
  here or over MCP are source: dynamic and survive restarts.
*/
import { readFileSync } from "node:fs";
import { alertRuleSchema, SqliteFlightRecorder } from "@luxalgo/whale-core";
import type { Command } from "commander";
import pc from "picocolors";
import { applyOverrides, type CommonFlags, loadConfig } from "../config-load.js";

interface RulesFlags extends CommonFlags {
  json?: string;
  file?: string;
}

export function registerRules(program: Command): void {
  const rules = program.command("rules").description("list, add, or remove alert rules");

  rules
    .command("list")
    .option("--config <path>")
    .option("--db <path>")
    .action(async (flags: RulesFlags) => {
      const { config } = await loadConfig(flags.config);
      applyOverrides(config, flags);
      const store = new SqliteFlightRecorder(config.store.path);
      const all = store.listRules();
      if (all.length === 0) {
        process.stdout.write(pc.dim("no rules; add one with `whale rules add --json '...'`\n"));
      }
      for (const { rule, source } of all) {
        const match = JSON.stringify(rule.match);
        process.stdout.write(
          `${rule.enabled ? pc.green("●") : pc.dim("○")} ${pc.bold(rule.id)} [${source}] → ${rule.sink.type}  ${pc.dim(match)}\n`,
        );
      }
      store.close();
    });

  rules
    .command("add")
    .description("add a rule from inline JSON or a file")
    .option("--config <path>")
    .option("--db <path>")
    .option("--json <rule>", "rule as inline JSON")
    .option("--file <path>", "rule as a JSON file")
    .action(async (flags: RulesFlags) => {
      const { config } = await loadConfig(flags.config);
      applyOverrides(config, flags);
      const raw = flags.json ?? (flags.file ? readFileSync(flags.file, "utf8") : null);
      if (!raw) throw new Error("provide --json '<rule>' or --file <path>");
      const parsed = alertRuleSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        throw new Error(
          `invalid rule:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`,
        );
      }
      const store = new SqliteFlightRecorder(config.store.path);
      store.upsertRule(parsed.data, "dynamic");
      store.close();
      process.stdout.write(`${pc.green("added")} ${parsed.data.id} → ${parsed.data.sink.type}\n`);
    });

  rules
    .command("remove <id>")
    .option("--config <path>")
    .option("--db <path>")
    .action(async (id: string, flags: RulesFlags) => {
      const { config } = await loadConfig(flags.config);
      applyOverrides(config, flags);
      const store = new SqliteFlightRecorder(config.store.path);
      const removed = store.removeRule(id);
      store.close();
      process.stdout.write(
        removed ? `${pc.green("removed")} ${id}\n` : pc.yellow(`no rule ${id}\n`),
      );
    });
}
