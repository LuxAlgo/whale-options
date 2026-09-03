/*
  One shared /ws subscription for the chart and GEX tabs: classified events
  and per-print flow buckets fan out to whoever is listening, the socket
  reconnects quietly, and it closes when the last listener leaves. The flow
  table keeps its own stream (use-live-events.ts) — untouched on purpose.
*/
import { useEffect, useState } from "react";
import type { LiveMessage } from "./types.js";

type Handler = (message: LiveMessage) => void;

const handlers = new Set<Handler>();
let socket: WebSocket | null = null;
let retry: number | undefined;
let wanted = false;

function connect(): void {
  if (!wanted || socket) return;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
  socket = ws;
  ws.onmessage = (msg) => {
    let data: LiveMessage;
    try {
      data = JSON.parse(String(msg.data)) as LiveMessage;
    } catch {
      return;
    }
    if (data.type !== "event" && data.type !== "flow") return;
    for (const h of handlers) h(data);
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    if (wanted) retry = window.setTimeout(connect, 2_000);
  };
}

/** Subscribe to live frames; returns the unsubscribe. */
export function subscribeLive(handler: Handler): () => void {
  handlers.add(handler);
  wanted = true;
  connect();
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) {
      wanted = false;
      window.clearTimeout(retry);
      socket?.close();
      socket = null;
    }
  };
}

/**
 * Latest spot seen for an underlying on the live stream — the close of the
 * newest flow bucket, or an event's spot — for live GEX re-pricing. Null
 * until the stream has said anything about the name.
 */
export function useLiveSpot(underlying: string | null): { spot: number | null; ts: number | null } {
  const [state, setState] = useState<{ spot: number | null; ts: number | null }>({
    spot: null,
    ts: null,
  });
  useEffect(() => {
    setState({ spot: null, ts: null });
    if (!underlying) return;
    let lastTs = 0;
    return subscribeLive((m) => {
      if (m.type === "event") {
        if (m.event.underlying !== underlying || m.event.spot === null) return;
        if (m.event.ts < lastTs) return;
        lastTs = m.event.ts;
        setState({ spot: m.event.spot, ts: m.event.ts });
        return;
      }
      for (const b of m.buckets) {
        if (b.underlying !== underlying || b.spotClose === null) continue;
        if (b.ts + b.bucketMs < lastTs) continue;
        lastTs = Math.max(lastTs, b.ts);
        setState({ spot: b.spotClose, ts: b.ts });
      }
    });
  }, [underlying]);
  return state;
}
