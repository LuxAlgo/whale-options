/*
  Dashboard shell. Deliberately thin: a live flow table with filters, an
  event drawer showing the full score breakdown, the chart (candles, the
  per-print flow panes, event markers, GEX levels — drawn by Vela, loaded on
  first visit), the GEX ladder and heatmap, the market structure analytics,
  score calibration (audit), and recorded-tape playback — the engine is the
  product, this is a window onto it. Visited tabs stay
  mounted (hidden, not unmounted) so streams, fetched panels, and playback
  position survive tab switches.
*/
import { useState } from "react";
import { AuditView } from "./audit-view.js";
import { ChartView } from "./chart-view.js";
import { FlowView } from "./flow-view.js";
import { int } from "./format.js";
import { GexView } from "./gex-view.js";
import { LuxAlgoMark } from "./luxalgo-mark.js";
import { MarketView } from "./market-view.js";
import { PlaybackView } from "./playback-view.js";
import { useStatus } from "./use-status.js";

type Tab = "flow" | "chart" | "gex" | "market" | "audit" | "playback";

export function App() {
  const { status, reachable, live, error } = useStatus();
  const [tab, setTab] = useState<Tab>("flow");
  const [visited, setVisited] = useState<Record<Tab, boolean>>({
    flow: true,
    chart: false,
    gex: false,
    market: false,
    audit: false,
    playback: false,
  });

  const pick = (next: Tab) => {
    setTab(next);
    setVisited((prev) => (prev[next] ? prev : { ...prev, [next]: true }));
  };

  return (
    <div className="flex h-screen flex-col bg-zinc-950 font-mono text-zinc-100">
      <header className="flex items-baseline gap-4 border-b border-zinc-800 px-4 py-3">
        <span className="flex items-center gap-2.5 self-center">
          <a
            href="https://luxalgo.com"
            target="_blank"
            rel="noreferrer"
            title="LuxAlgo"
            className="text-zinc-100 transition-colors hover:text-white"
          >
            <LuxAlgoMark className="h-[18px] w-auto" />
          </a>
          <h1 className="text-lg font-bold tracking-tight">Whale Options</h1>
        </span>
        <span className="hidden text-xs text-zinc-500 sm:inline">
          options flow, detection included · self-hosted
        </span>
        {status && (
          <span className="ml-auto hidden text-[10px] text-zinc-600 md:inline">
            ticks {int(status.ticks)} · events {int(status.events)} · baselines{" "}
            {status.baselineSessions.length}
            {status.feed ? ` · feed ${status.feed}` : ""}
          </span>
        )}
        <span
          className={`${status ? "" : "ml-auto "}rounded px-2 py-0.5 text-xs ${
            live ? "bg-emerald-900 text-emerald-300" : "bg-zinc-800 text-zinc-400"
          }`}
        >
          {live ? "engine live" : "engine offline"}
        </span>
      </header>

      <nav className="flex gap-1 border-b border-zinc-800 px-4" aria-label="views">
        <TabButton active={tab === "flow"} onClick={() => pick("flow")}>
          flow
        </TabButton>
        <TabButton active={tab === "chart"} onClick={() => pick("chart")}>
          chart
        </TabButton>
        <TabButton active={tab === "gex"} onClick={() => pick("gex")}>
          gex
        </TabButton>
        <TabButton active={tab === "market"} onClick={() => pick("market")}>
          market
        </TabButton>
        <TabButton active={tab === "audit"} onClick={() => pick("audit")}>
          audit
        </TabButton>
        <TabButton active={tab === "playback"} onClick={() => pick("playback")}>
          playback
        </TabButton>
      </nav>

      {!reachable && (
        <p className="border-b border-amber-900/40 bg-amber-950/30 px-4 py-2 text-xs text-amber-400">
          No engine reachable{error ? ` (${error})` : ""}. Start one with{" "}
          <code className="bg-zinc-900 px-1">whale run --feed synthetic</code> — this page
          reconnects on its own.
        </p>
      )}

      <main className="flex min-h-0 flex-1 flex-col px-4 py-3">
        <div className={tab === "flow" ? "min-h-0 flex-1" : "hidden"}>
          <FlowView engineReachable={reachable} />
        </div>
        {visited.chart && (
          <div className={tab === "chart" ? "min-h-0 flex-1" : "hidden"}>
            <ChartView status={status} active={tab === "chart"} />
          </div>
        )}
        {visited.gex && (
          <div className={tab === "gex" ? "min-h-0 flex-1 overflow-y-auto" : "hidden"}>
            <GexView chains={status?.chains_available ?? []} active={tab === "gex"} />
          </div>
        )}
        {visited.market && (
          <div className={tab === "market" ? "min-h-0 flex-1 overflow-y-auto" : "hidden"}>
            <MarketView chains={status?.chains_available ?? []} />
          </div>
        )}
        {visited.audit && (
          <div className={tab === "audit" ? "min-h-0 flex-1 overflow-y-auto" : "hidden"}>
            <AuditView />
          </div>
        )}
        {visited.playback && (
          <div className={tab === "playback" ? "min-h-0 flex-1" : "hidden"}>
            <PlaybackView status={status} />
          </div>
        )}
      </main>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-2 text-xs ${
        active
          ? "border-zinc-200 text-zinc-100"
          : "border-transparent text-zinc-500 hover:text-zinc-300"
      }`}
    >
      {children}
    </button>
  );
}
