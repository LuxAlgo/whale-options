/*
  The main view: a dense, live flow table — the terminal renderer's visual
  sibling (same columns, same color language, newest first). Auto-scroll is
  pinned to the top; scrolling down or hovering rows pauses the stream into a
  buffer and a "paused — N new" pill offers the way back. Filters drive both
  the seeded query and the live stream.
*/
import { useCallback, useRef, useState } from "react";
import { ContractText, KindBadge, ScoreText, SideText } from "./event-bits.js";
import { EventDrawer } from "./event-drawer.js";
import { etTime, int, money } from "./format.js";
import type { EventKind, FlowEvent, Side } from "./types.js";
import { DEFAULT_FILTERS, type FlowFilters, useLiveEvents } from "./use-live-events.js";

const KINDS: EventKind[] = ["sweep", "block", "split", "print"];
const SIDES: Side[] = ["buy", "sell", "mid", "unknown"];

export function FlowView({ engineReachable }: { engineReachable: boolean }) {
  const [filters, setFilters] = useState<FlowFilters>(DEFAULT_FILTERS);
  const [scrolledDown, setScrolledDown] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [selected, setSelected] = useState<FlowEvent | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const paused = scrolledDown || hovering;
  const { rows, pendingCount, flush, seedError } = useLiveEvents(filters, paused);

  const resume = useCallback(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    setScrolledDown(false);
    setHovering(false);
    flush();
  }, [flush]);

  const set = <K extends keyof FlowFilters>(key: K, value: FlowFilters[K]) =>
    setFilters((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <FiltersBar filters={filters} set={set} rowCount={rows.length} paused={paused} />

      <div className="relative min-h-0 flex-1">
        {paused && pendingCount > 0 && (
          <button
            type="button"
            onClick={resume}
            className="absolute left-1/2 top-9 z-20 -translate-x-1/2 rounded-full border border-amber-600/60 bg-amber-950 px-3 py-1 text-xs text-amber-300 shadow-lg hover:bg-amber-900"
          >
            paused: {int(pendingCount)} new · click to resume
          </button>
        )}
        <div
          ref={scrollRef}
          onScroll={(e) => setScrolledDown(e.currentTarget.scrollTop > 4)}
          className="h-full overflow-y-auto rounded border border-zinc-800"
        >
          <table className="w-full text-left text-xs tabular-nums">
            <thead className="sticky top-0 z-10 bg-zinc-950">
              <tr className="border-b border-zinc-800 text-[10px] uppercase tracking-wide text-zinc-500">
                <th className="px-2 py-1.5 font-normal">time (ET)</th>
                <th className="px-2 py-1.5 font-normal">kind</th>
                <th className="px-2 py-1.5 font-normal">side</th>
                <th className="px-2 py-1.5 font-normal">und</th>
                <th className="px-2 py-1.5 font-normal">contract</th>
                <th className="px-2 py-1.5 text-right font-normal">size @ vwap</th>
                <th className="px-2 py-1.5 text-right font-normal">premium</th>
                <th className="px-2 py-1.5 text-right font-normal">score</th>
                <th className="px-2 py-1.5 text-right font-normal">legs/exch</th>
              </tr>
            </thead>
            <tbody onMouseEnter={() => setHovering(true)} onMouseLeave={() => setHovering(false)}>
              {rows.map((event) => (
                <EventRow
                  key={event.id}
                  event={event}
                  selected={selected?.id === event.id}
                  onSelect={() => setSelected(event)}
                />
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-zinc-600">
                    {seedError
                      ? `event query failed: ${seedError}`
                      : engineReachable
                        ? "no events match; the table fills live as the engine emits"
                        : "no engine reachable"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected && <EventDrawer seed={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

/** One flow-table row — shared with the playback tab so the two tables agree. */
export function EventRow({
  event,
  selected,
  onSelect,
}: {
  event: FlowEvent;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <tr
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`cursor-pointer border-b border-zinc-900 outline-none last:border-0 hover:bg-zinc-900/70 focus-visible:bg-zinc-900/70 ${
        selected ? "bg-zinc-900" : ""
      }`}
    >
      <td className="px-2 py-1 text-zinc-500">{etTime(event.ts)}</td>
      <td className="px-2 py-1">
        <KindBadge kind={event.kind} />
      </td>
      <td className="px-2 py-1">
        <SideText side={event.side} />
      </td>
      <td className="px-2 py-1 font-bold text-zinc-100">{event.underlying}</td>
      <td className="px-2 py-1">
        <ContractText event={event} />
      </td>
      <td className="px-2 py-1 text-right text-zinc-300">
        {int(event.size)} @ {event.price.toFixed(2)}
      </td>
      <td className="px-2 py-1 text-right text-zinc-200">{money(event.premium)}</td>
      <td className="px-2 py-1 text-right">
        <ScoreText event={event} />
      </td>
      <td className="px-2 py-1 text-right text-zinc-500">
        {event.legCount}/{event.exchanges.length}
      </td>
    </tr>
  );
}

function FiltersBar({
  filters,
  set,
  rowCount,
  paused,
}: {
  filters: FlowFilters;
  set: <K extends keyof FlowFilters>(key: K, value: FlowFilters[K]) => void;
  rowCount: number;
  paused: boolean;
}) {
  const field =
    "rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        value={filters.ticker}
        onChange={(e) => set("ticker", e.target.value)}
        placeholder="ticker"
        aria-label="filter by ticker"
        className={`w-24 uppercase ${field}`}
      />
      <select
        value={filters.kind}
        onChange={(e) => set("kind", e.target.value as EventKind | "")}
        aria-label="filter by kind"
        className={field}
      >
        <option value="">all kinds</option>
        {KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {kind}
          </option>
        ))}
      </select>
      <select
        value={filters.side}
        onChange={(e) => set("side", e.target.value as Side | "")}
        aria-label="filter by side"
        className={field}
      >
        <option value="">all sides</option>
        {SIDES.map((side) => (
          <option key={side} value={side}>
            {side}
          </option>
        ))}
      </select>
      <input
        value={filters.minScore}
        onChange={(e) => set("minScore", e.target.value)}
        placeholder="min score"
        inputMode="numeric"
        aria-label="minimum whale score"
        className={`w-20 ${field}`}
      />
      <input
        value={filters.minPremium}
        onChange={(e) => set("minPremium", e.target.value)}
        placeholder="min premium $"
        inputMode="numeric"
        aria-label="minimum premium in dollars"
        className={`w-28 ${field}`}
      />
      <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-400">
        <input
          type="checkbox"
          checked={filters.excludeColdStart}
          onChange={(e) => set("excludeColdStart", e.target.checked)}
          className="accent-zinc-400"
        />
        hide cold-start
      </label>
      <span className="ml-auto text-[10px] text-zinc-600">
        {int(rowCount)} rows{paused ? " · paused" : " · live"}
      </span>
    </div>
  );
}
