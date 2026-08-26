/*
  The flow table's data spine: seed from GET /api/events, then merge live
  /ws pushes. One filter definition drives both — the seed re-queries the
  server, the stream is filtered client-side with the same predicate. While
  the table is "paused" (user scrolled down or hovering rows) live events
  buffer into `pending` instead of shifting rows under the pointer; resume
  merges them in. Everything is capped at MAX_ROWS — this is a tape reader's
  window, not the flight recorder.
*/
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { EventKind, FlowEvent, Side } from "./types.js";

export const MAX_ROWS = 500;

export interface FlowFilters {
  ticker: string;
  kind: EventKind | "";
  side: Side | "";
  minScore: string;
  minPremium: string;
  excludeColdStart: boolean;
}

export const DEFAULT_FILTERS: FlowFilters = {
  ticker: "",
  kind: "",
  side: "",
  minScore: "",
  minPremium: "",
  excludeColdStart: false,
};

/** Client-side twin of the server-side EventFilter semantics. */
export function matchesFilters(event: FlowEvent, f: FlowFilters): boolean {
  const ticker = f.ticker.trim().toUpperCase();
  if (ticker && event.underlying !== ticker) return false;
  if (f.kind && event.kind !== f.kind) return false;
  if (f.side && event.side !== f.side) return false;
  const minScore = Number(f.minScore);
  if (f.minScore.trim() !== "" && Number.isFinite(minScore) && event.score.total < minScore) {
    return false;
  }
  const minPremium = Number(f.minPremium);
  if (f.minPremium.trim() !== "" && Number.isFinite(minPremium) && event.premium < minPremium) {
    return false;
  }
  if (f.excludeColdStart && event.score.coldStart) return false;
  return true;
}

function seedUrl(f: FlowFilters): string {
  const params = new URLSearchParams();
  params.set("limit", String(MAX_ROWS));
  const ticker = f.ticker.trim().toUpperCase();
  if (ticker) params.set("underlying", ticker);
  if (f.kind) params.set("kind", f.kind);
  if (f.side) params.set("side", f.side);
  if (f.minScore.trim() !== "" && Number.isFinite(Number(f.minScore))) {
    params.set("minScore", f.minScore.trim());
  }
  if (f.minPremium.trim() !== "" && Number.isFinite(Number(f.minPremium))) {
    params.set("minPremium", f.minPremium.trim());
  }
  if (f.excludeColdStart) params.set("excludeColdStart", "true");
  return `/api/events?${params.toString()}`;
}

interface StreamState {
  rows: FlowEvent[];
  pending: FlowEvent[];
}

type StreamAction =
  | { type: "seed"; rows: FlowEvent[] }
  | { type: "live"; event: FlowEvent; paused: boolean }
  | { type: "flush" };

/** Newest first, deduped by id, capped. */
function merge(incoming: FlowEvent[], existing: FlowEvent[]): FlowEvent[] {
  const seen = new Set<string>();
  const out: FlowEvent[] = [];
  for (const event of [...incoming, ...existing]) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    out.push(event);
  }
  out.sort((a, b) => b.ts - a.ts || b.seq - a.seq);
  return out.slice(0, MAX_ROWS);
}

function streamReducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case "seed":
      return { rows: action.rows.slice(0, MAX_ROWS), pending: [] };
    case "live": {
      const { event } = action;
      const known = (e: FlowEvent) => e.id === event.id;
      if (state.rows.some(known) || state.pending.some(known)) return state;
      if (action.paused) {
        return { rows: state.rows, pending: [event, ...state.pending].slice(0, MAX_ROWS) };
      }
      return { rows: merge([event], state.rows), pending: state.pending };
    }
    case "flush":
      if (state.pending.length === 0) return state;
      return { rows: merge(state.pending, state.rows), pending: [] };
  }
}

export interface LiveEvents {
  rows: FlowEvent[];
  /** Buffered while paused; the "paused — N new" pill count. */
  pendingCount: number;
  /** Merge the buffer into the table (the pill's click). */
  flush: () => void;
  seedError: string | null;
}

export function useLiveEvents(filters: FlowFilters, paused: boolean): LiveEvents {
  const [state, dispatch] = useReducer(streamReducer, { rows: [], pending: [] });
  const [seedError, setSeedError] = useState<string | null>(null);

  // The single long-lived WS handler reads these refs instead of re-binding.
  const filtersRef = useRef(filters);
  const pausedRef = useRef(paused);
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);
  useEffect(() => {
    pausedRef.current = paused;
    if (!paused) dispatch({ type: "flush" });
  }, [paused]);

  // Seed (and re-seed on filter change, debounced past keystrokes).
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(seedUrl(filters), { signal: controller.signal })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<{ events?: FlowEvent[] }>;
        })
        .then((body) => {
          dispatch({ type: "seed", rows: body.events ?? [] });
          setSeedError(null);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setSeedError(err instanceof Error ? err.message : String(err));
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [filters]);

  // Live stream, reconnecting quietly — the status poll owns "offline" UI.
  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    const connect = () => {
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${proto}://${window.location.host}/ws`);
      socket.onmessage = (msg) => {
        let data: { type?: string; event?: FlowEvent };
        try {
          data = JSON.parse(String(msg.data)) as { type?: string; event?: FlowEvent };
        } catch {
          return; // not a JSON frame; ignore
        }
        if (data.type !== "event" || !data.event) return;
        if (!matchesFilters(data.event, filtersRef.current)) return;
        dispatch({ type: "live", event: data.event, paused: pausedRef.current });
      };
      socket.onclose = () => {
        if (!disposed) retry = window.setTimeout(connect, 2_000);
      };
    };
    connect();
    return () => {
      disposed = true;
      window.clearTimeout(retry);
      socket?.close();
    };
  }, []);

  const flush = useCallback(() => dispatch({ type: "flush" }), []);

  return { rows: state.rows, pendingCount: state.pending.length, flush, seedError };
}
