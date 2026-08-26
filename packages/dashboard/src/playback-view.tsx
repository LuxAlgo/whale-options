/*
  Playback tab — the flight recorder made visible. Fetches one recorded
  window of events (ascending) and replays them on a client-side clock: a
  density scrubber, play/pause and speed controls, an ET tape clock, and the
  flow table filling as tape time advances. This is recorded tape playback of
  already-classified events — no engine in the browser, no re-classification.
*/
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EventDrawer } from "./event-drawer.js";
import { EventRow } from "./flow-view.js";
import { etDateTime, etTime, int } from "./format.js";
import type { EngineStatus, FlowEvent } from "./types.js";

const WINDOW_CHOICES = [15, 30, 60, 390] as const;
const SPEEDS = [1, 10, 60] as const;
const TICK_MS = 100;

interface Tape {
  from: number;
  to: number;
  events: FlowEvent[]; // ascending by ts
}

export function PlaybackView({ status }: { status: EngineStatus | null }) {
  const [windowMin, setWindowMin] = useState<number>(30);
  const [tape, setTape] = useState<Tape | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tapeTs, setTapeTs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(10);
  const [selected, setSelected] = useState<FlowEvent | null>(null);

  // The recorded window ends at the last thing on the tape when "load" runs;
  // it does NOT chase a live engine — playback is a read of the recorder.
  const statusRef = useRef(status);
  statusRef.current = status;

  const load = useCallback((minutes: number) => {
    const s = statusRef.current;
    const to = s?.lastEventTs ?? s?.lastTickTs ?? Date.now();
    const from = to - minutes * 60_000;
    setLoading(true);
    setPlaying(false);
    const params = new URLSearchParams({
      from: String(from),
      to: String(to),
      limit: "1000",
      order: "asc",
    });
    fetch(`/api/events?${params.toString()}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ events?: FlowEvent[] }>;
      })
      .then((body) => {
        setTape({ from, to, events: body.events ?? [] });
        setTapeTs(from);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, []);

  // Auto-load once the first status poll answers (it carries the tape extent).
  const loaded = tape !== null || loadError !== null;
  useEffect(() => {
    if (status !== null && !loaded && !loading) load(30);
  }, [status, loaded, loading, load]);

  // The tape clock: advance by wall-time delta × speed while playing.
  useEffect(() => {
    if (!playing || tape === null) return;
    let last = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      setTapeTs((prev) => Math.min(tape.to, prev + dt * speed));
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [playing, speed, tape]);

  // Stop at the end of the recorded window.
  useEffect(() => {
    if (playing && tape !== null && tapeTs >= tape.to) setPlaying(false);
  }, [playing, tape, tapeTs]);

  const played = useMemo(() => {
    if (tape === null) return [];
    // events are ascending; everything at or before the tape clock has "printed".
    const out: FlowEvent[] = [];
    for (const e of tape.events) {
      if (e.ts > tapeTs) break;
      out.push(e);
    }
    out.reverse(); // newest first, like the live flow table
    return out;
  }, [tape, tapeTs]);

  const atEnd = tape !== null && tapeTs >= tape.to;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <p className="text-[10px] text-zinc-500">
        <span className="font-bold uppercase tracking-wide text-zinc-400">
          recorded tape playback
        </span>{" "}
        : replaying events already classified and stored in the flight recorder; no engine in the
        browser, no re-classification.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={windowMin}
          onChange={(e) => {
            const minutes = Number(e.target.value);
            setWindowMin(minutes);
            load(minutes);
          }}
          aria-label="recorded window length"
          className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 focus:border-zinc-600 focus:outline-none"
        >
          {WINDOW_CHOICES.map((m) => (
            <option key={m} value={m}>
              last {m} min of tape
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => load(windowMin)}
          className="rounded border border-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
        >
          reload
        </button>
        <button
          type="button"
          onClick={() => {
            if (tape === null) return;
            if (atEnd) setTapeTs(tape.from); // replay from the top
            setPlaying((p) => !p);
          }}
          disabled={tape === null || tape.events.length === 0}
          className="w-20 rounded border border-zinc-700 bg-zinc-200 px-2 py-1 text-xs font-bold text-zinc-950 hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-600"
        >
          {playing ? "pause" : atEnd ? "replay" : "play"}
        </button>
        <div className="flex overflow-hidden rounded border border-zinc-800">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSpeed(s)}
              aria-pressed={speed === s}
              className={`px-2 py-1 text-xs ${
                speed === s
                  ? "bg-zinc-200 font-bold text-zinc-950"
                  : "bg-zinc-900 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {s}×
            </button>
          ))}
        </div>
        {tape !== null && (
          <span className="text-sm tabular-nums text-sky-400">
            {etDateTime(tapeTs)} <span className="text-[10px] text-zinc-500">ET tape time</span>
          </span>
        )}
        {loading && <span className="text-[10px] text-zinc-600">loading tape…</span>}
        {tape !== null && (
          <span className="ml-auto text-[10px] text-zinc-600">
            {int(played.length)} / {int(tape.events.length)} events played
            {tape.events.length >= 1000 ? " · capped at 1000" : ""}
          </span>
        )}
      </div>

      {loadError && <p className="text-xs text-amber-400">tape fetch failed: {loadError}</p>}

      {tape !== null && (
        <Scrubber
          tape={tape}
          tapeTs={tapeTs}
          onSeek={(ts) => {
            setTapeTs(ts);
          }}
        />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto rounded border border-zinc-800">
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
          <tbody>
            {played.map((event) => (
              <EventRow
                key={event.id}
                event={event}
                selected={selected?.id === event.id}
                onSelect={() => setSelected(event)}
              />
            ))}
            {played.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-zinc-600">
                  {tape === null
                    ? "no tape loaded"
                    : tape.events.length === 0
                      ? "no events recorded in this window; pick a longer one"
                      : "press play (or scrub); the table fills as tape time advances"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && <EventDrawer seed={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

const SCRUB_W = 860;
const SCRUB_H = 48;
const BINS = 120;

/** Event-density timeline with a draggable playhead (hand-rolled SVG). */
function Scrubber({
  tape,
  tapeTs,
  onSeek,
}: {
  tape: Tape;
  tapeTs: number;
  onSeek: (ts: number) => void;
}) {
  const span = Math.max(1, tape.to - tape.from);

  const bins = useMemo(() => {
    const counts = new Array<number>(BINS).fill(0);
    for (const e of tape.events) {
      const i = Math.min(BINS - 1, Math.floor(((e.ts - tape.from) / span) * BINS));
      counts[i] = (counts[i] ?? 0) + 1;
    }
    return counts;
  }, [tape, span]);
  const maxCount = Math.max(1, ...bins);

  const playX = ((tapeTs - tape.from) / span) * SCRUB_W;

  const seekFromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    onSeek(tape.from + frac * span);
  };

  return (
    // Slider semantics + keyboard live on the div; the SVG inside is paint.
    <div
      role="slider"
      tabIndex={0}
      aria-label="tape position"
      aria-valuemin={tape.from}
      aria-valuemax={tape.to}
      aria-valuenow={Math.round(tapeTs)}
      aria-valuetext={`${etTime(tapeTs)} ET`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        seekFromPointer(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) seekFromPointer(e);
      }}
      onKeyDown={(e) => {
        const step = span / 60; // one minute of a 60-minute tape, scaled
        if (e.key === "ArrowRight") onSeek(Math.min(tape.to, tapeTs + step));
        if (e.key === "ArrowLeft") onSeek(Math.max(tape.from, tapeTs - step));
        if (e.key === "Home") onSeek(tape.from);
        if (e.key === "End") onSeek(tape.to);
      }}
      className="cursor-crosshair select-none rounded border border-zinc-800 bg-zinc-950 outline-none focus-visible:border-zinc-500"
    >
      <svg viewBox={`0 0 ${SCRUB_W} ${SCRUB_H}`} className="h-12 w-full" aria-hidden="true">
        {/* density bars: played portion lit, the rest waiting */}
        {bins.map((count, i) => {
          if (count === 0) return null;
          const barW = SCRUB_W / BINS;
          const x = i * barW;
          const h = Math.max(2, (count / maxCount) * (SCRUB_H - 16));
          const playedBin = x + barW / 2 <= playX;
          return (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: bins are positional by construction
              key={i}
              x={x + 0.5}
              y={SCRUB_H - 12 - h}
              width={barW - 1}
              height={h}
              rx={0.5}
              className={playedBin ? "fill-sky-500/80" : "fill-zinc-700"}
            />
          );
        })}

        {/* baseline + playhead */}
        <line
          x1={0}
          x2={SCRUB_W}
          y1={SCRUB_H - 12}
          y2={SCRUB_H - 12}
          className="stroke-zinc-800"
          strokeWidth={1}
        />
        <line
          x1={playX}
          x2={playX}
          y1={2}
          y2={SCRUB_H - 12}
          className="stroke-sky-400"
          strokeWidth={1.5}
        />

        <text x={2} y={SCRUB_H - 2} fontSize={9} className="fill-zinc-600">
          {etTime(tape.from)}
        </text>
        <text
          x={SCRUB_W - 2}
          y={SCRUB_H - 2}
          fontSize={9}
          textAnchor="end"
          className="fill-zinc-600"
        >
          {etTime(tape.to)}
        </text>
      </svg>
    </div>
  );
}
