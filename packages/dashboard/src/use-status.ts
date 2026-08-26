/*
  Engine status poll. One place decides "is the engine there / alive" for the
  header badge, the offline banner, and the GEX underlying picker
  (chains_available). Polling — not WS — so an engine that died mid-session
  flips the UI to offline within a poll interval.
*/
import { useEffect, useState } from "react";
import type { EngineStatus } from "./types.js";

const POLL_MS = 5_000;
/** Heartbeats land every ~5s; older than this means no engine writing. */
const LIVE_WITHIN_MS = 15_000;

export interface StatusState {
  status: EngineStatus | null;
  /** HTTP reachable — false renders the "start an engine" banner. */
  reachable: boolean;
  /** Reachable and heartbeat fresh — a run is actually writing. */
  live: boolean;
  error: string | null;
}

export function useStatus(): StatusState {
  const [state, setState] = useState<StatusState>({
    status: null,
    reachable: true,
    live: false,
    error: null,
  });

  useEffect(() => {
    let disposed = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/status");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const status = (await res.json()) as EngineStatus;
        if (disposed) return;
        const live =
          status.heartbeatTs !== null && Date.now() - status.heartbeatTs < LIVE_WITHIN_MS;
        setState({ status, reachable: true, live, error: null });
      } catch (err) {
        if (disposed) return;
        setState((prev) => ({
          status: prev.status,
          reachable: false,
          live: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  return state;
}
