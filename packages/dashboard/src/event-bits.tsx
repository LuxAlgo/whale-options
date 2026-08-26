/*
  Shared visual atoms for flow events — kind badge, side, score, contract —
  used by both the table and the drawer so the two always agree. Colors
  mirror the terminal renderer: sweep magenta, block cyan, split yellow,
  print muted; buy green, sell red; score ≥80 hot, ≥60 warm, else muted.
*/
import { strikeText } from "./format.js";
import type { FlowEvent, Right, Side } from "./types.js";

const KIND_CLASSES: Record<FlowEvent["kind"], string> = {
  sweep: "text-fuchsia-400 border-fuchsia-400/30 bg-fuchsia-400/10",
  block: "text-cyan-400 border-cyan-400/30 bg-cyan-400/10",
  split: "text-yellow-400 border-yellow-400/30 bg-yellow-400/10",
  print: "text-zinc-500 border-zinc-700 bg-zinc-800/40",
};

export function KindBadge({ kind }: { kind: FlowEvent["kind"] }) {
  return (
    <span
      className={`inline-block w-12 text-center border rounded px-1 text-[10px] font-bold leading-4 ${KIND_CLASSES[kind]}`}
    >
      {kind.toUpperCase()}
    </span>
  );
}

export function SideText({ side }: { side: Side }) {
  if (side === "buy") return <span className="text-emerald-400 font-bold">BUY</span>;
  if (side === "sell") return <span className="text-red-400 font-bold">SELL</span>;
  if (side === "mid") return <span className="text-zinc-500">MID</span>;
  return <span className="text-zinc-600">?</span>;
}

export function scoreClass(total: number): string {
  if (total >= 80) return "text-red-400 font-bold";
  if (total >= 60) return "text-amber-400";
  return "text-zinc-500";
}

/** Score number with the cold-start marker `*` the terminal uses. */
export function ScoreText({ event }: { event: FlowEvent }) {
  return (
    <span className={scoreClass(event.score.total)}>
      {event.score.total.toFixed(0)}
      <span className="text-zinc-600 font-normal">{event.score.coldStart ? "*" : " "}</span>
    </span>
  );
}

export function RightText({ right }: { right: Right }) {
  return right === "C" ? (
    <span className="text-emerald-400">C</span>
  ) : (
    <span className="text-red-400">P</span>
  );
}

/** "C $190 09-18" — right, strike, short expiry, like the terminal line. */
export function ContractText({ event }: { event: Pick<FlowEvent, "right" | "strike" | "expiry"> }) {
  return (
    <span>
      <RightText right={event.right} /> {strikeText(event.strike)}{" "}
      <span className="text-zinc-400">{event.expiry.slice(5)}</span>
    </span>
  );
}
