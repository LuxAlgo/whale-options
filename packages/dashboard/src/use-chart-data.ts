/*
  Data hooks for the chart tab: the per-print flow series (seed from the API,
  then live /ws buckets folded in), the underlying bars (feed or spot tape,
  polled while live), the session's events for the markers, and the
  throttled live GEX re-pricing. Every hook keeps the server's notes so the
  view can print them next to the numbers they qualify.
*/
import { useEffect, useRef, useState } from "react";
import { sessionBoundsUtc } from "./flow-math.js";
import { subscribeLive } from "./live-socket.js";
import type {
  BarsPayload,
  FlowBucket,
  FlowEvent,
  FlowSeriesPayload,
  FlowSessions,
  GexHeatmap,
  GexLadder,
  UnderlyingBar,
} from "./types.js";
import { useApi } from "./use-api.js";

export function useFlowSessions(): FlowSessions | null {
  const { data } = useApi<FlowSessions>("/api/flow/sessions");
  return data;
}

export interface FlowSeriesState {
  buckets: FlowBucket[];
  note: string | null;
  error: string | null;
  loading: boolean;
}

/** The raw (stored-width) buckets of one session, live-updated when `live`. */
export function useFlowSeries(
  underlying: string | null,
  session: string | null,
  live: boolean,
): FlowSeriesState {
  const [state, setState] = useState<FlowSeriesState>({
    buckets: [],
    note: null,
    error: null,
    loading: false,
  });

  useEffect(() => {
    setState({ buckets: [], note: null, error: null, loading: underlying !== null });
    if (!underlying || !session) return;
    const controller = new AbortController();
    fetch(`/api/flow/${encodeURIComponent(underlying)}/series?session=${session}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        const body = (await res.json()) as { series?: FlowSeriesPayload; error?: string };
        if (!res.ok || !body.series) throw new Error(body.error ?? `HTTP ${res.status}`);
        setState((prev) => ({
          buckets: mergeBuckets(body.series?.buckets ?? [], prev.buckets),
          note: body.series?.note ?? null,
          error: null,
          loading: false,
        }));
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          buckets: [],
          note: null,
          error: err instanceof Error ? err.message : String(err),
          loading: false,
        });
      });
    return () => controller.abort();
  }, [underlying, session]);

  useEffect(() => {
    if (!live || !underlying || !session) return;
    return subscribeLive((m) => {
      if (m.type !== "flow") return;
      const mine = m.buckets.filter(
        (b) => b.underlying === underlying && b.sessionDate === session,
      );
      if (mine.length === 0) return;
      setState((prev) => ({ ...prev, buckets: mergeBuckets(mine, prev.buckets) }));
    });
  }, [live, underlying, session]);

  return state;
}

/** Upsert by bucket ts (incoming wins), ascending. */
function mergeBuckets(incoming: FlowBucket[], existing: FlowBucket[]): FlowBucket[] {
  const byTs = new Map<number, FlowBucket>();
  for (const b of existing) byTs.set(b.ts, b);
  for (const b of incoming) byTs.set(b.ts, b);
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

export interface BarsState {
  bars: UnderlyingBar[];
  source: string | null;
  sourceKind: BarsPayload["sourceKind"] | null;
  note: string | null;
  error: string | null;
}

const BAR_POLL_MS = 5_000;

/** Bars for the session at a timeframe; while `live`, the tail is re-polled every few seconds. */
export function useBars(
  underlying: string | null,
  session: string | null,
  tf: string,
  live: boolean,
): BarsState {
  const [state, setState] = useState<BarsState>({
    bars: [],
    source: null,
    sourceKind: null,
    note: null,
    error: null,
  });
  const barsRef = useRef<UnderlyingBar[]>([]);

  useEffect(() => {
    barsRef.current = [];
    setState({ bars: [], source: null, sourceKind: null, note: null, error: null });
    if (!underlying || !session) return;
    let disposed = false;
    let timer: number | undefined;
    const load = async (tail: boolean) => {
      const params = new URLSearchParams({ tf, session });
      const last = barsRef.current[barsRef.current.length - 1];
      if (tail && last) {
        const { to } = sessionBoundsUtc(session);
        params.set("from", String(last.ts));
        params.set("to", String(to));
      }
      try {
        const res = await fetch(`/api/bars/${encodeURIComponent(underlying)}?${params}`);
        const body = (await res.json()) as BarsPayload & { error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        if (disposed) return;
        const merged = tail ? mergeBars(body.bars, barsRef.current) : body.bars;
        barsRef.current = merged;
        setState({
          bars: merged,
          source: body.source,
          sourceKind: body.sourceKind,
          note: body.note,
          error: null,
        });
      } catch (err) {
        if (disposed) return;
        setState((prev) => ({ ...prev, error: err instanceof Error ? err.message : String(err) }));
      }
    };
    void load(false);
    if (live) {
      timer = window.setInterval(() => {
        if (document.visibilityState === "visible") void load(true);
      }, BAR_POLL_MS);
    }
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [underlying, session, tf, live]);

  return state;
}

function mergeBars(incoming: UnderlyingBar[], existing: UnderlyingBar[]): UnderlyingBar[] {
  const byTs = new Map<number, UnderlyingBar>();
  for (const b of existing) byTs.set(b.ts, b);
  for (const b of incoming) byTs.set(b.ts, b);
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

/** The marker kinds: the engine's classified structures, not every emitted print. */
const MARKER_KINDS = ["sweep", "block", "split"] as const;

/** The session's sweeps/blocks/splits for one underlying (markers), live-appended when `live`. */
export function useSessionEvents(
  underlying: string | null,
  session: string | null,
  live: boolean,
): FlowEvent[] {
  const [events, setEvents] = useState<FlowEvent[]>([]);

  useEffect(() => {
    setEvents([]);
    if (!underlying || !session) return;
    const controller = new AbortController();
    const { from, to } = sessionBoundsUtc(session);
    // One query per kind: the API caps a page at 1,000 rows, and a busy
    // session's prints would otherwise crowd out the morning's sweeps.
    void Promise.all(
      MARKER_KINDS.map((kind) => {
        const params = new URLSearchParams({
          underlying,
          kind,
          from: String(from),
          to: String(to),
          limit: "1000",
          order: "asc",
        });
        return fetch(`/api/events?${params}`, { signal: controller.signal })
          .then((res) => res.json() as Promise<{ events?: FlowEvent[] }>)
          .then((body) => body.events ?? [])
          .catch(() => [] as FlowEvent[]);
      }),
    ).then((pages) => {
      if (controller.signal.aborted) return;
      setEvents((prev) => mergeEvents(pages.flat(), prev));
    });
    return () => controller.abort();
  }, [underlying, session]);

  useEffect(() => {
    if (!live || !underlying || !session) return;
    return subscribeLive((m) => {
      if (m.type !== "event") return;
      if (m.event.underlying !== underlying || m.event.sessionDate !== session) return;
      if (!(MARKER_KINDS as readonly string[]).includes(m.event.kind)) return;
      setEvents((prev) => mergeEvents([m.event], prev));
    });
  }, [live, underlying, session]);

  return events;
}

function mergeEvents(incoming: FlowEvent[], existing: FlowEvent[]): FlowEvent[] {
  const byId = new Map<string, FlowEvent>();
  for (const e of existing) byId.set(e.id, e);
  for (const e of incoming) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.ts - b.ts || a.seq - b.seq).slice(-2000);
}

export interface LiveGexState {
  ladder: GexLadder | null;
  heatmap: GexHeatmap | null;
  error: string | null;
  loading: boolean;
}

const REPRICE_MS = 2_000;

/**
 * GEX ladder (and optionally the heatmap) for an underlying, re-priced at the
 * latest live spot at most every REPRICE_MS while `enabled` and the page is
 * visible. The chain is never refetched here — only re-evaluated; the
 * payload's pricing line says so.
 */
export function useLiveGex(
  underlying: string | null,
  liveSpot: number | null,
  enabled: boolean,
  withHeatmap: boolean,
): LiveGexState {
  const [state, setState] = useState<LiveGexState>({
    ladder: null,
    heatmap: null,
    error: null,
    loading: false,
  });
  const lastFetchRef = useRef(0);
  const pendingRef = useRef<number | undefined>(undefined);
  const spotRef = useRef<number | null>(liveSpot);
  spotRef.current = liveSpot;

  useEffect(() => {
    setState({ ladder: null, heatmap: null, error: null, loading: underlying !== null });
    lastFetchRef.current = 0;
    if (!underlying || !enabled) return;
    let disposed = false;

    const fetchAt = async (spot: number | null) => {
      lastFetchRef.current = Date.now();
      const q = spot !== null && spot > 0 ? `?spot=${spot}` : "";
      try {
        const [ladderRes, heatRes] = await Promise.all([
          fetch(`/api/gex/${encodeURIComponent(underlying)}${q}`),
          withHeatmap ? fetch(`/api/gex/${encodeURIComponent(underlying)}/heatmap${q}`) : null,
        ]);
        const ladderBody = (await ladderRes.json()) as { gex?: GexLadder; error?: string };
        if (!ladderRes.ok || !ladderBody.gex) {
          throw new Error(ladderBody.error ?? `HTTP ${ladderRes.status}`);
        }
        let heatmap: GexHeatmap | null = null;
        if (heatRes) {
          const heatBody = (await heatRes.json()) as { heatmap?: GexHeatmap; error?: string };
          if (!heatRes.ok || !heatBody.heatmap) {
            throw new Error(heatBody.error ?? `HTTP ${heatRes.status}`);
          }
          heatmap = heatBody.heatmap;
        }
        if (disposed) return;
        setState({ ladder: ladderBody.gex, heatmap, error: null, loading: false });
      } catch (err) {
        if (disposed) return;
        setState((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : String(err),
          loading: false,
        }));
      }
    };

    // First paint at the snapshot's own spot (or the live one if already known).
    void fetchAt(spotRef.current);
    return () => {
      disposed = true;
      window.clearTimeout(pendingRef.current);
    };
  }, [underlying, enabled, withHeatmap]);

  // Live re-pricing: trailing-edge throttle at REPRICE_MS, page visible only.
  useEffect(() => {
    if (!underlying || !enabled || liveSpot === null) return;
    const run = () => {
      if (document.visibilityState !== "visible") return;
      lastFetchRef.current = Date.now();
      const q = `?spot=${liveSpot}`;
      void (async () => {
        try {
          const [ladderRes, heatRes] = await Promise.all([
            fetch(`/api/gex/${encodeURIComponent(underlying)}${q}`),
            withHeatmap ? fetch(`/api/gex/${encodeURIComponent(underlying)}/heatmap${q}`) : null,
          ]);
          const ladderBody = (await ladderRes.json()) as { gex?: GexLadder };
          const heatBody = heatRes ? ((await heatRes.json()) as { heatmap?: GexHeatmap }) : null;
          if (!ladderBody.gex) return;
          setState((prev) => ({
            ladder: ladderBody.gex ?? prev.ladder,
            heatmap: heatBody?.heatmap ?? prev.heatmap,
            error: null,
            loading: false,
          }));
        } catch {
          // keep the last good pricing; the status line shows its timestamp
        }
      })();
    };
    const wait = Math.max(0, REPRICE_MS - (Date.now() - lastFetchRef.current));
    window.clearTimeout(pendingRef.current);
    pendingRef.current = window.setTimeout(run, wait);
    return () => window.clearTimeout(pendingRef.current);
  }, [underlying, enabled, withHeatmap, liveSpot]);

  return state;
}
