/*
  Shared plumbing for the real vendor adapters. Every live feed has the same
  skeleton — a socket that pushes, an async iterable that pulls, reconnects
  with capped backoff, and REST lookups that must fail soft — so the pieces
  live here once: an async push→pull queue, abortable sleep, the backoff
  schedule, and a fetch helper that turns non-2xx into readable errors.
*/

/** Thrown for unrecoverable feed errors (bad credentials, missing entitlement).
 *  Reconnect loops rethrow these instead of retrying into the same wall. */
export class FeedAuthError extends Error {}

/** Unbounded async push queue bridging socket callbacks to async iteration.
 *  `end()` finishes the iterator; `fail(err)` makes the consumer throw. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private rejecters: Array<(err: unknown) => void> = [];
  private ended = false;
  private error: unknown = null;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      this.rejecters.shift();
      waiter({ value, done: false });
    } else {
      this.values.push(value);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
    this.rejecters.length = 0;
  }

  fail(err: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.error = err;
    const rejecters = this.rejecters.splice(0);
    this.waiters.length = 0;
    for (const reject of rejecters) reject(err);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.values.length > 0) {
          const value = this.values.shift() as T;
          return Promise.resolve({ value, done: false });
        }
        if (this.error !== null) return Promise.reject(this.error);
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push(resolve);
          this.rejecters.push(reject);
        });
      },
    };
  }
}

/** Abortable sleep; resolves early (never rejects) when the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Capped exponential backoff: 1s, 2s, 4s, ... capped at 30s. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

export interface FetchJsonOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** HTTP method; defaults to GET. */
  method?: string;
}

/**
 * fetch + JSON with readable failures. 401/403 become FeedAuthError so the
 * caller can distinguish "fix your key" from "retry later". Callers that can
 * degrade (missing entitlement on an enrichment endpoint) catch and move on.
 */
export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers: options.headers,
    signal: options.signal ?? null,
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    const message = `${options.method ?? "GET"} ${url.replace(/([?&](?:apiKey|token)=)[^&]+/i, "$1***")} -> HTTP ${res.status}${body ? `: ${body}` : ""}`;
    if (res.status === 401 || res.status === 403) throw new FeedAuthError(message);
    throw new Error(message);
  }
  return (await res.json()) as T;
}

/** fetch returning the raw body text (NDJSON endpoints); same error policy. */
export async function fetchText(url: string, options: FetchJsonOptions = {}): Promise<string> {
  const res = await fetch(url, {
    method: options.method ?? "GET",
    headers: options.headers,
    signal: options.signal ?? null,
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    const message = `${options.method ?? "GET"} ${url} -> HTTP ${res.status}${body ? `: ${body}` : ""}`;
    if (res.status === 401 || res.status === 403) throw new FeedAuthError(message);
    throw new Error(message);
  }
  return await res.text();
}

/** Parse an NDJSON body into rows, skipping blank or torn lines. */
export function parseNdjson<T>(body: string): T[] {
  const rows: T[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as T);
    } catch {
      // tolerate a torn trailing line
    }
  }
  return rows;
}
