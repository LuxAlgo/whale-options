/*
  The chart tab's drawing layer, on Vela (@luxalgo/vela, Apache-2.0). This
  module is loaded with a dynamic import from chart-view.tsx so the flow
  table's bundle never carries the charting library.

  What it puts on screen:
    - the underlying's candles (feed bars or the spot tape — the caller says
      which in the UI; this module draws what it is given),
    - three study panes as engine-free native indicators: net premium
      (calls green, puts red, net line), directional delta, net volume,
    - a renderer layer painting sweep/block/split markers at each event's
      time and spot, sized by premium, colored by side, calls above / puts
      below, with hover cards and click-through to the event drawer,
    - a renderer layer painting per-strike net GEX as bars anchored to the
      price axis with the zero-gamma level dashed and the convention in a
      small legend.

  Vela's attribution mark stays on — the library's NOTICE asks for it.
*/
import {
  type NativeIndicatorContext,
  NativeRenderer,
  type OHLCV,
  type PriceLine,
  type RendererLayerArgs,
  registerNativeIndicator,
  registerRendererLayer,
  type SeriesPoint,
  type SeriesSpec,
  Vela,
  type VelaTheme,
} from "@luxalgo/vela";
import type { FlowPoint } from "./flow-math.js";
import { etTime, money, signedMoney } from "./format.js";
import type { FlowEvent, GexLadder, UnderlyingBar } from "./types.js";

// The dashboard's own palette (Tailwind zinc/emerald/red), as literal hex —
// Vela's renderer takes color strings, not CSS variables.
export const CHART_THEME: VelaTheme = {
  background: "#09090b",
  textColor: "#a1a1aa",
  gridColor: "#18181b",
  borderColor: "#27272a",
  upColor: "#10b981",
  downColor: "#ef4444",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
};

const BUY = "#34d399";
const SELL = "#f87171";
const UNSIDED = "#71717a";
const NET = "#e4e4e7";
const AMBER = "#fbbf24";
const SKY = "#38bdf8";

const MARKERS_LAYER = "whale-flow-markers";
const GEX_LAYER = "whale-gex-levels";
const PANE_NET_PREMIUM = "whale-net-premium";
const PANE_DELTA = "whale-directional-delta";
const PANE_NET_VOLUME = "whale-net-volume";

export interface FlowChartHandle {
  setBars(bars: UnderlyingBar[], timeframe: string): void;
  setFlow(points: FlowPoint[]): void;
  setMarkers(events: FlowEvent[]): void;
  /** null hides the layer. */
  setGexLevels(ladder: GexLadder | null): void;
  destroy(): void;
}

export interface FlowChartOptions {
  timeframe: string;
  onMarkerClick(eventId: string): void;
}

// ---------------------------------------------------------------------------
// Study panes: native indicators fed from a module-level holder. Vela keeps
// one instance per type per chart; the dashboard mounts one chart at a time,
// so the holder is the current chart's data and each instance re-emits when
// told to.
// ---------------------------------------------------------------------------

interface PaneState {
  points: FlowPoint[];
  ctx: Map<string, NativeIndicatorContext>;
}

const paneState: PaneState = { points: [], ctx: new Map() };

const lineStyle = (color: string, width = 1) => ({ color, width, lineStyle: "solid" as const });

function pointsOf(
  points: FlowPoint[],
  pick: (p: FlowPoint) => number,
  colorBy?: (p: FlowPoint) => string,
): SeriesPoint[] {
  return points.map((p) => {
    const value = pick(p);
    return colorBy ? { time: p.time, value, color: colorBy(p) } : { time: p.time, value };
  });
}

const signColor = (v: number) => (v >= 0 ? BUY : SELL);

function seriesFor(
  type: string,
  points: FlowPoint[],
): { series: SeriesSpec[]; priceLines: PriceLine[] } {
  const zero: PriceLine = {
    id: `${type}:zero`,
    paneId: type,
    price: 0,
    color: "#3f3f46",
    lineStyle: "dotted",
    width: 1,
  };
  if (type === PANE_NET_PREMIUM) {
    return {
      series: [
        {
          id: `${type}:net-bucket`,
          title: "net premium / bucket",
          paneId: type,
          kind: "histogram",
          points: pointsOf(
            points,
            (p) => p.netPremium,
            (p) => (p.netPremium >= 0 ? "rgba(52,211,153,0.35)" : "rgba(248,113,113,0.35)"),
          ),
          style: { ...lineStyle("#52525b"), base: 0 },
        },
        {
          id: `${type}:calls`,
          title: "calls, cumulative",
          paneId: type,
          kind: "line",
          points: pointsOf(points, (p) => p.cumCallNet),
          style: lineStyle(BUY),
        },
        {
          id: `${type}:puts`,
          title: "puts, cumulative",
          paneId: type,
          kind: "line",
          points: pointsOf(points, (p) => p.cumPutNet),
          style: lineStyle(SELL),
        },
        {
          id: `${type}:net`,
          title: "net, cumulative",
          paneId: type,
          kind: "line",
          points: pointsOf(points, (p) => p.cumNetPremium),
          style: lineStyle(NET, 2),
        },
      ],
      priceLines: [zero],
    };
  }
  if (type === PANE_DELTA) {
    return {
      series: [
        {
          id: `${type}:bucket`,
          title: "directional delta / bucket",
          paneId: type,
          kind: "histogram",
          points: pointsOf(
            points,
            (p) => p.directionalDelta,
            (p) => (p.directionalDelta >= 0 ? "rgba(52,211,153,0.35)" : "rgba(248,113,113,0.35)"),
          ),
          style: { ...lineStyle("#52525b"), base: 0 },
        },
        {
          id: `${type}:cum`,
          title: "directional delta, cumulative",
          paneId: type,
          kind: "line",
          points: pointsOf(
            points,
            (p) => p.cumDirectionalDelta,
            (p) => signColor(p.cumDirectionalDelta),
          ),
          style: lineStyle(NET, 2),
        },
      ],
      priceLines: [zero],
    };
  }
  return {
    series: [
      {
        id: `${type}:bucket`,
        title: "net volume / bucket",
        paneId: type,
        kind: "histogram",
        points: pointsOf(
          points,
          (p) => p.netVolume,
          (p) => (p.netVolume >= 0 ? "rgba(52,211,153,0.55)" : "rgba(248,113,113,0.55)"),
        ),
        style: { ...lineStyle("#52525b"), base: 0 },
      },
      {
        id: `${type}:cum`,
        title: "net volume, cumulative",
        paneId: type,
        kind: "line",
        points: pointsOf(points, (p) => p.cumNetVolume),
        style: lineStyle(NET, 2),
      },
    ],
    priceLines: [zero],
  };
}

function emitPane(type: string): void {
  const ctx = paneState.ctx.get(type);
  if (!ctx) return;
  ctx.emit(seriesFor(type, paneState.points));
  ctx.setStatus("idle");
}

let registered = false;

/** Register the panes and layers once per page (Vela's registries are global). */
function ensureRegistered(): void {
  if (registered) return;
  registered = true;

  const panes: Array<[string, string, string]> = [
    [PANE_NET_PREMIUM, "Net premium (every print)", "net premium"],
    [PANE_DELTA, "Directional delta (Σ δ × size × 100 × side)", "dir. delta"],
    [PANE_NET_VOLUME, "Net volume (buy − sell contracts)", "net volume"],
  ];
  for (const [type, title, shortTitle] of panes) {
    registerNativeIndicator({
      type,
      title,
      shortTitle,
      paneHint: "new",
      overlay: false,
      inputsSchema: () => [],
      defaultInputs: () => ({}),
      create: () => ({
        start(ctx) {
          paneState.ctx.set(type, ctx);
          emitPane(type);
        },
        onBars() {},
        onViewport() {},
        setInputs() {},
        suspend() {},
        resume() {
          emitPane(type);
        },
        stop() {
          if (paneState.ctx.get(type)) paneState.ctx.delete(type);
        },
      }),
    });
  }

  registerRendererLayer({
    id: MARKERS_LAYER,
    placement: "above-data",
    repaintOnCursor: true,
    create: createMarkersLayer,
  });
  registerRendererLayer({
    id: GEX_LAYER,
    placement: "below-data",
    repaintOnCursor: false,
    create: createGexLayer,
  });
}

// ---------------------------------------------------------------------------
// Markers layer
// ---------------------------------------------------------------------------

interface MarkerPayload {
  events: FlowEvent[];
}

interface PaintedMarker {
  x: number;
  y: number;
  r: number;
  event: FlowEvent;
}

interface MarkersInstance {
  canvas: HTMLCanvasElement | null;
  painted: PaintedMarker[];
}

const markerInstances = new Set<MarkersInstance>();
const HIT_PX = 10;

/** Premium → marker radius in px: $10K reads, $5M stands out, nothing dominates. */
function markerRadius(premium: number): number {
  const r = 3 + 2.4 * Math.log10(Math.max(1, premium / 10_000));
  return Math.max(3, Math.min(12, r));
}

function sideColor(side: FlowEvent["side"]): string {
  return side === "buy" ? BUY : side === "sell" ? SELL : UNSIDED;
}

function drawShape(
  ctx: CanvasRenderingContext2D,
  kind: FlowEvent["kind"],
  x: number,
  y: number,
  r: number,
  up: boolean,
): void {
  ctx.beginPath();
  switch (kind) {
    case "sweep": {
      // Triangle whose tip points back at the spot it sits above/below.
      const tipY = up ? y + r : y - r;
      const baseY = up ? y - r : y + r;
      ctx.moveTo(x, tipY);
      ctx.lineTo(x - r, baseY);
      ctx.lineTo(x + r, baseY);
      ctx.closePath();
      break;
    }
    case "block":
      ctx.rect(x - r * 0.85, y - r * 0.85, r * 1.7, r * 1.7);
      break;
    case "split":
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      break;
    default:
      ctx.arc(x, y, r * 0.7, 0, Math.PI * 2);
  }
}

function createMarkersLayer() {
  const inst: MarkersInstance = { canvas: null, painted: [] };
  return {
    mount(canvas: HTMLCanvasElement) {
      inst.canvas = canvas;
      markerInstances.add(inst);
    },
    render(args: RendererLayerArgs) {
      const canvas = inst.canvas;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const { coords, scale, bounds, cursor, theme } = args;
      const dpr = coords.dpr || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, coords.width, coords.height);
      inst.painted = [];
      const data = args.data as MarkerPayload | undefined;
      if (!data || data.events.length === 0 || args.bars.length === 0) return;

      const painted: PaintedMarker[] = [];
      for (const event of data.events) {
        if (event.spot === null || !Number.isFinite(event.spot)) continue;
        const x = coords.timeToX(event.ts);
        if (x < -20 || x > coords.width + 20) continue;
        const spotY = coords.priceToY(event.spot, scale, bounds);
        if (spotY < bounds.top - 40 || spotY > bounds.top + bounds.height + 40) continue;
        const r = markerRadius(event.premium);
        // Calls sit above the bar, puts below — the vertical side IS the right.
        const y = event.right === "C" ? spotY - 6 - r : spotY + 6 + r;
        painted.push({ x, y, r, event });
      }
      inst.painted = painted;

      // Small first so big prints never bury small ones.
      painted.sort((a, b) => b.r - a.r);
      for (const m of painted) {
        drawShape(ctx, m.event.kind, m.x, m.y, m.r, m.event.right === "C");
        ctx.fillStyle = sideColor(m.event.side);
        ctx.globalAlpha = m.event.side === "buy" || m.event.side === "sell" ? 0.9 : 0.6;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(0,0,0,0.5)";
        ctx.stroke();
      }

      if (!cursor) return;
      const hover = nearest(painted, cursor.x, cursor.y);
      if (!hover) return;
      const e = hover.event;
      ctx.beginPath();
      ctx.arc(hover.x, hover.y, hover.r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = sideColor(e.side);
      ctx.lineWidth = 1.5;
      ctx.stroke();

      const lines = [
        `${e.kind.toUpperCase()} ${e.side.toUpperCase()} ${e.underlying} ${e.right} $${e.strike} ${e.expiry.slice(5)}`,
        `${e.size.toLocaleString("en-US")} @ ${e.price.toFixed(2)} · ${money(e.premium)} · score ${e.score.total.toFixed(0)}${e.score.coldStart ? "*" : ""}`,
        `${etTime(e.ts)} ET · spot ${e.spot?.toFixed(2)} · ${e.legCount} leg${e.legCount === 1 ? "" : "s"} / ${e.exchanges.length} exch · click for the breakdown`,
      ];
      ctx.font = `11px ${theme.fontFamily}`;
      const pad = 8;
      const lineH = 15;
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
      const h = lines.length * lineH + pad * 2 - 4;
      let bx = hover.x + 14;
      let by = hover.y - h - 10;
      if (bx + w > coords.width - 4) bx = hover.x - w - 14;
      if (by < bounds.top + 4) by = hover.y + 14;
      bx = Math.max(4, Math.min(bx, coords.width - w - 4));
      ctx.beginPath();
      ctx.roundRect(bx, by, w, h, 4);
      ctx.fillStyle = "#18181b";
      ctx.globalAlpha = 0.97;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#3f3f46";
      ctx.lineWidth = 1;
      ctx.stroke();
      lines.forEach((line, i) => {
        ctx.fillStyle = i === 0 ? sideColor(e.side) : "#d4d4d8";
        ctx.fillText(line, bx + pad, by + pad + 10 + i * lineH);
      });
    },
    destroy() {
      markerInstances.delete(inst);
      inst.canvas = null;
    },
  };
}

function nearest(painted: PaintedMarker[], x: number, y: number): PaintedMarker | null {
  let best: PaintedMarker | null = null;
  let bestD = HIT_PX * HIT_PX;
  for (const m of painted) {
    const dx = m.x - x;
    const dy = m.y - y;
    const d = dx * dx + dy * dy - m.r * m.r;
    if (d <= bestD) {
      bestD = d;
      best = m;
    }
  }
  return best;
}

/** The marker under a pointer event, if the pointer is over a markers canvas. */
function markerAtClient(clientX: number, clientY: number): FlowEvent | null {
  for (const inst of markerInstances) {
    if (!inst.canvas) continue;
    const rect = inst.canvas.getBoundingClientRect();
    if (
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    ) {
      continue;
    }
    const hit = nearest(inst.painted, clientX - rect.left, clientY - rect.top);
    if (hit) return hit.event;
  }
  return null;
}

// ---------------------------------------------------------------------------
// GEX levels layer
// ---------------------------------------------------------------------------

interface GexPayload {
  ladder: GexLadder | null;
}

function createGexLayer() {
  let canvas: HTMLCanvasElement | null = null;
  return {
    mount(c: HTMLCanvasElement) {
      canvas = c;
    },
    render(args: RendererLayerArgs) {
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const { coords, scale, bounds, theme } = args;
      const dpr = coords.dpr || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, coords.width, coords.height);
      const ladder = (args.data as GexPayload | undefined)?.ladder;
      if (!ladder || ladder.perStrike.length === 0) return;

      const maxAbs = Math.max(1, ...ladder.perStrike.map((r) => Math.abs(r.netGex)));
      const maxLen = coords.width * 0.22;
      const right = coords.width - 2;
      const rowPx = Math.abs(
        coords.priceToY(ladder.perStrike[1]?.strike ?? ladder.spot * 1.01, scale, bounds) -
          coords.priceToY(ladder.perStrike[0]?.strike ?? ladder.spot, scale, bounds),
      );
      const barH = Math.max(2, Math.min(10, rowPx * 0.6));
      ctx.font = `10px ${theme.fontFamily}`;
      ctx.textAlign = "right";
      let inView = 0;
      for (const row of ladder.perStrike) {
        if (row.strike < scale.min || row.strike > scale.max) continue;
        inView++;
        const y = coords.priceToY(row.strike, scale, bounds);
        const len = (Math.abs(row.netGex) / maxAbs) * maxLen;
        ctx.fillStyle = row.netGex >= 0 ? "rgba(16,185,129,0.28)" : "rgba(239,68,68,0.28)";
        ctx.fillRect(right - len, y - barH / 2, len, barH);
        if (len > 48 && rowPx >= 11) {
          ctx.fillStyle = row.netGex >= 0 ? "rgba(52,211,153,0.9)" : "rgba(248,113,113,0.9)";
          ctx.fillText(`${row.strike} ${signedMoney(row.netGex)}`, right - len - 4, y + 3.5);
        }
      }

      if (
        ladder.zeroGamma &&
        ladder.zeroGamma.level >= scale.min &&
        ladder.zeroGamma.level <= scale.max
      ) {
        const y = coords.priceToY(ladder.zeroGamma.level, scale, bounds);
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = AMBER;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(coords.width, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = AMBER;
        ctx.textAlign = "left";
        ctx.fillText(`zero-gamma ${ladder.zeroGamma.level.toFixed(2)}`, 6, y - 4);
      }

      // Legend: the assumption travels with the bars, always.
      const legend = [
        `GEX per 1% move · ${inView} of ${ladder.perStrike.length} strikes in view · ${ladder.convention}`,
        `assumption: ${ladder.conventionNote.split(".")[0]}`,
        ladder.pricing.note,
      ];
      ctx.textAlign = "left";
      const pad = 6;
      const lineH = 13;
      const w = Math.min(
        coords.width - 8,
        Math.max(...legend.map((l) => ctx.measureText(l).width)) + pad * 2,
      );
      const h = legend.length * lineH + pad * 2 - 3;
      const bx = 4;
      const by = bounds.top + bounds.height - h - 6;
      ctx.fillStyle = "rgba(24,24,27,0.92)";
      ctx.beginPath();
      ctx.roundRect(bx, by, w, h, 3);
      ctx.fill();
      ctx.strokeStyle = "rgba(251,191,36,0.35)";
      ctx.stroke();
      legend.forEach((line, i) => {
        ctx.fillStyle = i === 0 ? SKY : i === 1 ? AMBER : "#a1a1aa";
        let text = line;
        while (text.length > 8 && ctx.measureText(text).width > w - pad * 2)
          text = `${text.slice(0, -2)}…`;
        ctx.fillText(text, bx + pad, by + pad + 9 + i * lineH);
      });
    },
    destroy() {
      canvas = null;
    },
  };
}

// ---------------------------------------------------------------------------
// The chart handle
// ---------------------------------------------------------------------------

function toOhlcv(bars: UnderlyingBar[]): OHLCV[] {
  return bars.map((b) => ({
    time: b.ts,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    ...(b.volume === null ? {} : { volume: b.volume }),
  }));
}

export function createFlowChart(host: HTMLElement, opts: FlowChartOptions): FlowChartHandle {
  ensureRegistered();
  let chart: Vela | null = null;
  let renderer: NativeRenderer | null = null;
  let timeframe = opts.timeframe;
  let bars: OHLCV[] = [];
  let markers: FlowEvent[] = [];
  let gex: GexLadder | null = null;
  let disposed = false;

  const onClick = (e: MouseEvent) => {
    const hit = markerAtClient(e.clientX, e.clientY);
    if (hit) opts.onMarkerClick(hit.id);
  };
  host.addEventListener("click", onClick);

  const pushLayers = () => {
    renderer?.setNativeData(MARKERS_LAYER, { events: markers } satisfies MarkerPayload);
    renderer?.setNativeData(GEX_LAYER, { ladder: gex } satisfies GexPayload);
  };

  const build = () => {
    if (disposed || chart || bars.length === 0) return;
    renderer = new NativeRenderer();
    chart = new Vela(
      host,
      {
        data: bars,
        timeframe,
        theme: CHART_THEME,
        drawings: false,
        volume: false,
        live: false,
        currentPriceLine: true,
        animations: false,
      },
      { renderer },
    );
    chart.renderer.set("timezone", "America/New_York");
    chart.addNativeIndicator(PANE_NET_PREMIUM);
    chart.addNativeIndicator(PANE_DELTA);
    chart.addNativeIndicator(PANE_NET_VOLUME);
    pushLayers();
    void chart.ready().then(() => {
      if (!disposed) pushLayers();
    });
  };

  return {
    setBars(next, tf) {
      const data = toOhlcv(next);
      const tfChanged = tf !== timeframe;
      timeframe = tf;
      bars = data;
      if (!chart) {
        build();
        return;
      }
      if (data.length === 0) return;
      // Swap bars in place: panes, layers, and subscriptions survive; the
      // viewport is kept unless the timeframe changed (then Vela reframes).
      const visible = tfChanged ? undefined : (chart.getVisibleRange() ?? undefined);
      void chart.setMarket({ data, timeframe, ...(visible ? { visibleRange: visible } : {}) });
    },
    setFlow(points) {
      paneState.points = points;
      for (const type of [PANE_NET_PREMIUM, PANE_DELTA, PANE_NET_VOLUME]) emitPane(type);
    },
    setMarkers(events) {
      markers = events;
      pushLayers();
    },
    setGexLevels(ladder) {
      gex = ladder;
      pushLayers();
    },
    destroy() {
      disposed = true;
      host.removeEventListener("click", onClick);
      paneState.points = [];
      chart?.destroy();
      chart = null;
      renderer = null;
      host.replaceChildren();
    },
  };
}
