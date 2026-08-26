/*
  Terminal rendering for flow events. The default line answers "what just
  happened" at a glance; --verbose unfolds the whole story — the reasons
  trail and the full score breakdown — because showing the work is the
  point of this project.
*/

import { easternOffsetMs, type FlowEvent, type ScoreComponentName } from "@luxalgo/whale-core";
import pc from "picocolors";

const KIND_BADGE: Record<FlowEvent["kind"], string> = {
  sweep: pc.bold(pc.magenta("SWEEP")),
  block: pc.bold(pc.cyan("BLOCK")),
  split: pc.bold(pc.yellow("SPLIT")),
  print: pc.dim("PRINT"),
};

function etTime(ts: number): string {
  const local = new Date(ts + easternOffsetMs(ts));
  return local.toISOString().slice(11, 19);
}

function money(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return `$${Math.round(v)}`;
}

function sideText(side: FlowEvent["side"]): string {
  if (side === "buy") return pc.green("BUY ");
  if (side === "sell") return pc.red("SELL");
  if (side === "mid") return pc.dim("MID ");
  return pc.dim("?   ");
}

function scoreText(event: FlowEvent): string {
  const total = event.score.total;
  const label = total.toFixed(0).padStart(3);
  const cold = event.score.coldStart ? pc.dim("*") : " ";
  if (total >= 80) return pc.bold(pc.red(label)) + cold;
  if (total >= 60) return pc.yellow(label) + cold;
  if (total >= 40) return pc.white(label) + cold;
  return pc.dim(label) + cold;
}

export function renderEventLine(event: FlowEvent): string {
  const right = event.right === "C" ? pc.green("C") : pc.red("P");
  const contract = `${pc.bold(event.underlying.padEnd(5))} ${right} $${event.strike} ${event.expiry.slice(5)}`;
  const flow = `${event.size.toString().padStart(5)} @ ${event.price.toFixed(2).padStart(7)}`;
  const legs =
    event.legCount > 1 ? pc.dim(` ${event.legCount} legs/${event.exchanges.length} exch`) : "";
  return [
    pc.dim(etTime(event.ts)),
    KIND_BADGE[event.kind].padEnd(5),
    sideText(event.side),
    contract,
    flow,
    money(event.premium).padStart(8),
    `score ${scoreText(event)}`,
    legs,
  ].join("  ");
}

const COMPONENT_ORDER: ScoreComponentName[] = [
  "volumeVsBaseline",
  "premiumVsBaseline",
  "volOi",
  "aggression",
  "urgency",
  "repetition",
];

export function renderBreakdown(event: FlowEvent): string {
  const lines: string[] = [];
  for (const reason of event.reasons) lines.push(pc.dim(`    · ${reason}`));
  lines.push(pc.dim("    score breakdown:"));
  for (const name of COMPONENT_ORDER) {
    const c = event.score.components[name];
    const label = name.padEnd(18);
    if (c.value === null) {
      lines.push(pc.dim(`      ${label} n/a    (${c.note ?? "unavailable"})`));
      continue;
    }
    const bar = "█".repeat(Math.round(c.value * 12)).padEnd(12, "·");
    const pts = `${(c.weighted ?? 0).toFixed(1)} pts`;
    const raw = Object.entries(c.raw)
      .map(([k, v]) => `${k}=${v === null ? "∅" : v}`)
      .join(" ");
    lines.push(`      ${label} ${bar} ${pts.padStart(9)}  ${pc.dim(raw)}`);
  }
  if (event.score.coldStart) {
    lines.push(pc.dim(`      * cold start (${event.score.baselineDays} baseline sessions)`));
  }
  return lines.join("\n");
}

export function renderEvent(event: FlowEvent, verbose: boolean): string {
  return verbose ? `${renderEventLine(event)}\n${renderBreakdown(event)}` : renderEventLine(event);
}
