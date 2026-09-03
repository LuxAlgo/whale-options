/*
  Chart tab — the tape on a price chart. Candles of the underlying (the
  feed's bars, or the spot tape from prints when the feed has none — the
  badge says which), three study panes built from EVERY print (net premium,
  directional delta, net volume), sweep/block/split markers you can click
  into the event drawer, and optional per-strike GEX levels re-priced at the
  live spot. Drawn by Vela (https://github.com/LuxAlgo/Vela), loaded on
  first visit so the flow table stays as light as before. The notes under
  the chart are the engine's own, verbatim.
*/
import { useEffect, useMemo, useRef, useState } from "react";
import { EventDrawer } from "./event-drawer.js";
import { buildFlowPoints, flowCounts } from "./flow-math.js";
import { etDateTime, int, signedMoney } from "./format.js";
import { useLiveSpot } from "./live-socket.js";
import type { EngineStatus, FlowEvent } from "./types.js";
import {
  useBars,
  useFlowSeries,
  useFlowSessions,
  useLiveGex,
  useSessionEvents,
} from "./use-chart-data.js";
import type { FlowChartHandle } from "./vela-chart.js";

const TIMEFRAMES: Array<{ tf: string; label: string; ms: number }> = [
  { tf: "1m", label: "1m", ms: 60_000 },
  { tf: "5m", label: "5m", ms: 300_000 },
  { tf: "15m", label: "15m", ms: 900_000 },
];

/** Vela's timeframe token is bare minutes. */
const velaTimeframe = (tf: string) => tf.replace(/m$/, "");

export function ChartView({ status, active }: { status: EngineStatus | null; active: boolean }) {
  const sessions = useFlowSessions();
  const underlyings = useMemo(() => {
    const set = new Set<string>([
      ...(status?.chains_available ?? []),
      ...(sessions?.underlyings ?? []),
    ]);
    return [...set].sort();
  }, [status?.chains_available, sessions?.underlyings]);

  const [pickedUnderlying, setPickedUnderlying] = useState("");
  const underlying =
    pickedUnderlying !== "" && underlyings.includes(pickedUnderlying)
      ? pickedUnderlying
      : (underlyings[0] ?? null);

  const today = sessions?.today ?? null;
  const sessionChoices = useMemo(() => {
    const set = new Set<string>(sessions?.sessions ?? []);
    if (today) set.add(today);
    return [...set].sort().reverse();
  }, [sessions?.sessions, today]);
  const [pickedSession, setPickedSession] = useState("");
  const session =
    pickedSession !== "" && sessionChoices.includes(pickedSession)
      ? pickedSession
      : (today ?? sessionChoices[0] ?? null);
  const live = session !== null && session === today;

  const [tfIndex, setTfIndex] = useState(0);
  const tf = TIMEFRAMES[tfIndex] ?? TIMEFRAMES[0]!;
  const [gexOn, setGexOn] = useState(false);
  const [selected, setSelected] = useState<FlowEvent | null>(null);

  const flow = useFlowSeries(underlying, session, live && active);
  const bars = useBars(underlying, session, tf.tf, live && active);
  const events = useSessionEvents(underlying, session, live && active);
  const liveSpot = useLiveSpot(live && active ? underlying : null);
  const gex = useLiveGex(underlying, liveSpot.spot, gexOn && active, false);

  const points = useMemo(() => buildFlowPoints(flow.buckets, tf.ms), [flow.buckets, tf.ms]);
  const counts = useMemo(() => flowCounts(flow.buckets), [flow.buckets]);

  // The chart itself: one handle per mount, Vela loaded lazily; data flows
  // through setters so nothing rebuilds on live updates.
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<FlowChartHandle | null>(null);
  const [chartReady, setChartReady] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);
  const eventsRef = useRef<FlowEvent[]>([]);
  eventsRef.current = events;
  const tfRef = useRef(tf.tf);
  tfRef.current = tf.tf;

  // One chart per (underlying, session): a market switch tears the chart
  // down and mounts a fresh one so bars and panes never bleed across names.
  // Timeframe changes reach the existing chart through setBars instead.
  const identity = `${underlying ?? ""}|${session ?? ""}`;
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    setChartReady(false);
    import("./vela-chart.js")
      .then((mod) => {
        if (disposed) return;
        handleRef.current = mod.createFlowChart(host, {
          timeframe: velaTimeframe(tfRef.current),
          onMarkerClick: (id) => {
            const hit = eventsRef.current.find((e) => e.id === id);
            if (hit) setSelected(hit);
          },
        });
        setChartReady(true);
      })
      .catch((err: unknown) => {
        if (!disposed) setChartError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      disposed = true;
      handleRef.current?.destroy();
      handleRef.current = null;
    };
  }, [identity]);

  useEffect(() => {
    if (chartReady) handleRef.current?.setBars(bars.bars, velaTimeframe(tf.tf));
  }, [chartReady, bars.bars, tf.tf]);
  useEffect(() => {
    if (chartReady) handleRef.current?.setFlow(points);
  }, [chartReady, points]);
  useEffect(() => {
    if (chartReady) handleRef.current?.setMarkers(events);
  }, [chartReady, events]);
  useEffect(() => {
    if (chartReady) handleRef.current?.setGexLevels(gexOn ? gex.ladder : null);
  }, [chartReady, gexOn, gex.ladder]);

  const field =
    "rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 focus:border-zinc-600 focus:outline-none";
  const lastPoint = points[points.length - 1];

  if (underlyings.length === 0) {
    return (
      <p className="max-w-xl text-xs leading-5 text-zinc-500">
        Nothing to chart yet: the chart needs an underlying with prints or a chain snapshot. Start
        an engine (<code className="bg-zinc-900 px-1">whale run --feed synthetic</code>) and the
        picker fills within a few seconds.
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={underlying ?? ""}
          onChange={(e) => setPickedUnderlying(e.target.value)}
          aria-label="underlying"
          className={field}
        >
          {underlyings.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
        <select
          value={session ?? ""}
          onChange={(e) => setPickedSession(e.target.value)}
          aria-label="session date"
          className={field}
        >
          {sessionChoices.map((d) => (
            <option key={d} value={d}>
              {d}
              {d === today ? " (today, live)" : " (recorded)"}
            </option>
          ))}
        </select>
        <fieldset
          className="flex overflow-hidden rounded border border-zinc-800"
          aria-label="timeframe"
        >
          {TIMEFRAMES.map((t, i) => (
            <button
              key={t.tf}
              type="button"
              onClick={() => setTfIndex(i)}
              aria-pressed={i === tfIndex}
              className={`px-2 py-1 text-xs ${
                i === tfIndex
                  ? "bg-zinc-800 text-zinc-100"
                  : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {t.label}
            </button>
          ))}
        </fieldset>
        <button
          type="button"
          onClick={() => setGexOn((v) => !v)}
          aria-pressed={gexOn}
          className={`rounded border px-2 py-1 text-xs ${
            gexOn
              ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
              : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200"
          }`}
        >
          GEX levels {gexOn ? "on" : "off"}
        </button>
        {bars.sourceKind === "spot-tape" && (
          <span
            className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-300"
            title={bars.note ?? undefined}
          >
            spot tape from prints
          </span>
        )}
        {bars.sourceKind === "feed" && (
          <span className="text-[10px] text-zinc-500" title={bars.note ?? undefined}>
            bars: {bars.source}
          </span>
        )}
        <span className="ml-auto text-[10px] text-zinc-600">
          {live ? "live session" : "recorded session"} · {int(bars.bars.length)} bars ·{" "}
          {int(counts.prints)} prints · {int(events.length)} events marked
          {lastPoint ? ` · net premium ${signedMoney(lastPoint.cumNetPremium)}` : ""}
        </span>
      </div>

      <div className="relative min-h-[420px] flex-1 overflow-hidden rounded border border-zinc-800 bg-zinc-950">
        <div ref={hostRef} className="absolute inset-0" />
        {(!chartReady || bars.bars.length === 0) && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-zinc-600">
            {chartError
              ? `chart failed to load: ${chartError}`
              : bars.error
                ? `bars query failed: ${bars.error}`
                : flow.error
                  ? `flow query failed: ${flow.error}`
                  : bars.bars.length === 0 && chartReady
                    ? "no bars for this session yet: the price pane fills as prints arrive"
                    : "loading chart…"}
          </div>
        )}
      </div>

      <div className="space-y-1 text-[10px] leading-4 text-zinc-500">
        <p>
          <span className="text-zinc-400">series</span> · every print, no premium floor ·{" "}
          {int(counts.sided)} sided, {int(counts.unsided)} unsided (mid/unknown/side-voiding
          conditions, excluded from sign), {int(counts.cancels)} cancels · delta:{" "}
          {int(counts.deltaFromChain)} from chain greeks, {int(counts.deltaFromBlackScholes)}{" "}
          Black-Scholes from the print's own NBBO mid/spot, {int(counts.deltaMissing)} missing
          (excluded, never guessed) · markers are the engine's emitted sweeps, blocks, and splits
          (the premium floor applies to markers only), sized by premium, colored by side, calls
          above / puts below; click one for its breakdown
        </p>
        {flow.note && <p className="max-w-5xl">note: {flow.note}</p>}
        {bars.note && <p className="max-w-5xl">bars: {bars.note}</p>}
        {gexOn && gex.ladder && (
          <p className="max-w-5xl text-amber-200/70">
            <span className="mr-1 font-bold uppercase text-amber-400/90">assumption</span>
            GEX levels: convention "{gex.ladder.convention}": {gex.ladder.conventionNote} ·{" "}
            {gex.ladder.pricing.note}
            {gex.ladder.pricing.repricedTs !== null
              ? ` · last re-priced ${etDateTime(gex.ladder.pricing.repricedTs)} ET`
              : ""}
          </p>
        )}
        {gexOn && gex.error && (
          <p className="text-amber-400">GEX levels unavailable: {gex.error}</p>
        )}
        <p>
          charts drawn by{" "}
          <a
            href="https://github.com/LuxAlgo/Vela"
            target="_blank"
            rel="noreferrer"
            className="text-zinc-400 underline decoration-zinc-700 hover:text-zinc-200"
          >
            Vela
          </a>{" "}
          in the browser; the engine computes every number shown.
        </p>
      </div>

      {selected && <EventDrawer seed={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
