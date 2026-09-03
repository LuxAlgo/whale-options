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
import type { FlowChartHandle, GexView } from "./vela-chart.js";

const TIMEFRAMES: Array<{ tf: string; label: string; ms: number }> = [
  { tf: "1m", label: "1m", ms: 60_000 },
  { tf: "5m", label: "5m", ms: 300_000 },
  { tf: "15m", label: "15m", ms: 900_000 },
];

/** Vela's timeframe token is bare minutes. */
const velaTimeframe = (tf: string) => tf.replace(/m$/, "");

const MARKER_KINDS = ["sweep", "block", "split"] as const;
type MarkerKind = (typeof MARKER_KINDS)[number];

/** Which emitted events get a marker. Default: the session's 40 largest prints by premium. */
interface MarkerFilter {
  kinds: Record<MarkerKind, boolean>;
  minScore: string;
  minPremium: string;
  /** Keep only the N largest by premium; null = every event that passes the other filters. */
  top: number | null;
}

const DEFAULT_TOP = 40;
const DEFAULT_MARKER_FILTER: MarkerFilter = {
  kinds: { sweep: true, block: true, split: true },
  minScore: "",
  minPremium: "",
  top: DEFAULT_TOP,
};

function filterMarkers(events: FlowEvent[], f: MarkerFilter): FlowEvent[] {
  const minScore = f.minScore.trim() === "" ? null : Number(f.minScore);
  const minPremium = f.minPremium.trim() === "" ? null : Number(f.minPremium);
  let kept = events.filter(
    (e) =>
      f.kinds[e.kind as MarkerKind] !== false &&
      (minScore === null || !Number.isFinite(minScore) || e.score.total >= minScore) &&
      (minPremium === null || !Number.isFinite(minPremium) || e.premium >= minPremium),
  );
  if (f.top !== null && kept.length > f.top) {
    kept = [...kept].sort((a, b) => b.premium - a.premium || a.ts - b.ts).slice(0, f.top);
    kept.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  }
  return kept;
}

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
  const [gexView, setGexView] = useState<GexView | null>(null);
  const [markerFilter, setMarkerFilter] = useState<MarkerFilter>(DEFAULT_MARKER_FILTER);
  const [selected, setSelected] = useState<FlowEvent | null>(null);

  const flow = useFlowSeries(underlying, session, live && active);
  const bars = useBars(underlying, session, tf.tf, live && active);
  const events = useSessionEvents(underlying, session, live && active);
  const liveSpot = useLiveSpot(live && active ? underlying : null);
  const gex = useLiveGex(underlying, liveSpot.spot, gexOn && active, false);

  const points = useMemo(() => buildFlowPoints(flow.buckets, tf.ms), [flow.buckets, tf.ms]);
  const counts = useMemo(() => flowCounts(flow.buckets), [flow.buckets]);
  const marked = useMemo(() => filterMarkers(events, markerFilter), [events, markerFilter]);

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: `identity` is the remount key — a market switch must tear the chart down and mount a fresh one
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
        handleRef.current.onGexView(setGexView);
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
    if (chartReady) handleRef.current?.setMarkers(marked);
  }, [chartReady, marked]);
  useEffect(() => {
    if (!gexOn) setGexView(null);
    if (chartReady) handleRef.current?.setGexLevels(gexOn ? gex.ladder : null);
  }, [chartReady, gexOn, gex.ladder]);
  const setMarker = <K extends keyof MarkerFilter>(key: K, value: MarkerFilter[K]) =>
    setMarkerFilter((prev) => ({ ...prev, [key]: value }));

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
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto">
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
        <span className="mx-1 h-5 w-px bg-zinc-800" aria-hidden="true" />
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">markers</span>
        {MARKER_KINDS.map((kind) => (
          <label
            key={kind}
            className="flex cursor-pointer items-center gap-1 text-[10px] text-zinc-400"
          >
            <input
              type="checkbox"
              checked={markerFilter.kinds[kind]}
              onChange={(e) =>
                setMarker("kinds", { ...markerFilter.kinds, [kind]: e.target.checked })
              }
              className="accent-zinc-400"
            />
            {kind}
          </label>
        ))}
        <input
          value={markerFilter.minScore}
          onChange={(e) => setMarker("minScore", e.target.value)}
          placeholder="min score"
          inputMode="numeric"
          aria-label="marker minimum whale score"
          className={`w-20 ${field}`}
        />
        <input
          value={markerFilter.minPremium}
          onChange={(e) => setMarker("minPremium", e.target.value)}
          placeholder="min premium $"
          inputMode="numeric"
          aria-label="marker minimum premium in dollars"
          className={`w-28 ${field}`}
        />
        <button
          type="button"
          onClick={() => setMarker("top", markerFilter.top === null ? DEFAULT_TOP : null)}
          aria-pressed={markerFilter.top === null}
          title={
            markerFilter.top === null
              ? "every event that passes the filters is marked"
              : `the ${DEFAULT_TOP} largest by premium that pass the filters are marked`
          }
          className={`rounded border px-2 py-1 text-xs ${
            markerFilter.top === null
              ? "border-zinc-600 bg-zinc-800 text-zinc-100"
              : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {markerFilter.top === null ? `top ${DEFAULT_TOP}` : "show all"}
        </button>
        <span className="text-[10px] text-zinc-500">
          {int(marked.length)} of {int(events.length)} marked
        </span>
      </div>

      <div className="relative min-h-[620px] flex-1 overflow-hidden rounded border border-zinc-800 bg-zinc-950">
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

      <p className="text-[10px] leading-4 text-zinc-400">
        <span className="text-zinc-500">{live ? "live session" : "recorded session"}</span> ·{" "}
        {int(bars.bars.length)} bars · {int(counts.prints)} prints ·{" "}
        {lastPoint ? (
          <>
            calls <Signed v={lastPoint.cumCallNet} /> · puts <Signed v={lastPoint.cumPutNet} /> ·
            net premium <Signed v={lastPoint.cumNetPremium} /> · directional delta{" "}
            <span
              className={lastPoint.cumDirectionalDelta >= 0 ? "text-emerald-400" : "text-red-400"}
            >
              {signedCompact(lastPoint.cumDirectionalDelta)}
            </span>{" "}
            · net volume{" "}
            <span className={lastPoint.cumNetVolume >= 0 ? "text-emerald-400" : "text-red-400"}>
              {signedCompact(lastPoint.cumNetVolume)} contracts
            </span>{" "}
            <span className="text-zinc-600">
              (panes plot premium in $M, delta and contracts in thousands)
            </span>
          </>
        ) : (
          <span className="text-zinc-600">no prints yet this session</span>
        )}
      </p>
      {gexOn && (
        <p className="rounded border border-amber-500/20 bg-amber-500/5 px-2 py-1 text-[10px] leading-4 text-amber-200/80">
          <span className="mr-1 font-bold uppercase text-amber-400/90">GEX levels</span>
          {gex.error
            ? `unavailable: ${gex.error}`
            : gex.ladder
              ? `${gexView ? `${int(gexView.inView)} of ${int(gexView.total)} strikes in view${gexView.inView === 0 ? " — zoom out to see the bars" : ""}` : "painting…"} · per 1% move · convention "${gex.ladder.convention}" (${gex.ladder.conventionNote.split(".")[0]}; an assumption, flip via config gexConvention) · ${gex.ladder.pricing.note}${gex.ladder.pricing.repricedTs !== null ? ` · last re-priced ${etDateTime(gex.ladder.pricing.repricedTs)} ET` : ""}`
              : "loading the chain…"}
        </p>
      )}

      <details className="text-[10px] leading-4 text-zinc-500">
        <summary className="cursor-pointer select-none text-zinc-400 hover:text-zinc-200">
          what is on this chart (every series defined, every exclusion counted)
        </summary>
        <div className="mt-1 space-y-1">
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
        </div>
      </details>
      <p className="text-[10px] leading-4 text-zinc-500">
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

      {selected && <EventDrawer seed={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function Signed({ v }: { v: number }) {
  const cls = v > 0 ? "text-emerald-400" : v < 0 ? "text-red-400" : "text-zinc-500";
  return <span className={cls}>{signedMoney(v)}</span>;
}

/** Signed compact count: +35.9K, -758.8K, +1.2M. */
function signedCompact(v: number): string {
  const sign = v < 0 ? "-" : "+";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${Math.round(abs)}`;
}
