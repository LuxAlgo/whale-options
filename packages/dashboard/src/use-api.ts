/*
  One-shot JSON GET with abort-on-change — the data spine for the market and
  audit tabs, whose endpoints are plain request/response reads (no streaming).
  Server errors arrive as {error}; both transport and server errors surface
  as a string the view renders instead of the panel.
*/
import { useEffect, useState } from "react";

export interface ApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/** Fetch `url` whenever it changes; pass null to render nothing. */
export function useApi<T>(url: string | null, debounceMs = 0): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({ data: null, error: null, loading: false });

  useEffect(() => {
    if (url === null) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    const controller = new AbortController();
    setState((prev) => ({ ...prev, loading: true }));
    const timer = setTimeout(() => {
      fetch(url, { signal: controller.signal })
        .then(async (res) => {
          const body = (await res.json()) as T & { error?: string };
          if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
          setState({ data: body, error: null, loading: false });
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setState({
            data: null,
            error: err instanceof Error ? err.message : String(err),
            loading: false,
          });
        });
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [url, debounceMs]);

  return state;
}
