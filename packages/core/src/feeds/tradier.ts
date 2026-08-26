/*
  Tradier adapter — brokerage market-data API (real-time for funded
  brokerage accounts; the sandbox has delayed REST and no streaming).

  Streaming (https://documentation.tradier.com/brokerage-api/streaming/):
  POST /v1/markets/events/session (Bearer TRADIER_ACCESS_TOKEN) issues a
  short-lived sessionid, then the client connects to
  wss://ws.tradier.com/v1/markets/events and sends one JSON payload:
  {symbols, sessionid, filter, linebreak, validOnly}. Symbols are concrete
  equity/OCC option symbols — there is no per-underlying wildcard — so the
  adapter enumerates each filtered underlying's contracts via
  GET /v1/markets/options/lookup and subscribes those. "timesale" events
  carry bid/ask at print time, which becomes the tick's NBBO.

  House quirk, load-bearing: Tradier collapses single-element collections to
  a bare object and empty ones to null or the string "null" — every
  collection read goes through list() below.

  Sale conditions: Tradier's timesale carries a `flag` string plus `cancel`
  and `correction` booleans; the flag vocabulary is not publicly documented
  (https://documentation.tradier.com/brokerage-api/reference/response/streaming),
  so the mapper emits the flag verbatim alongside synthesized "cancel" /
  "correction" / "session:*" tokens, and only the tokens normalize to
  specific conditions — unrecognized flags surface as "unknown", which the
  engine keeps but marks.

  Historical backfill: deliberately not implemented. Tradier's market-data
  API offers daily OHLC bars (GET /v1/markets/history) and equity-only
  intraday timesales (GET /v1/markets/timesales) — no per-print historical
  option trades are documented, and baselines synthesized from daily bars
  would not be the same per-print distributions the engine scores against.
  getHistoricalOptionTrades/getHistoricalChain therefore stay undefined so
  `whale backfill` can point users at the feeds that do support history.
*/
import { WebSocket } from "ws";
import { parseOcc } from "../occ.js";
import type { ChainContract, ChainSnapshot, Nbbo, NormalizedCondition, Right } from "../types.js";
import { AsyncQueue, backoffMs, FeedAuthError, fetchJson, sleep } from "./feed-util.js";
import type { FeedAdapter, FeedCapabilities, RawOptionTrade, TradeFilter } from "./types.js";

export interface TradierOptions {
  accessToken: string;
  /** REST base; https://sandbox.tradier.com/v1 for sandbox REST testing. */
  apiBase?: string;
  wsUrl?: string;
}

/**
 * Tradier returns single-element collections as a bare object and empty
 * collections as null or the string "null" — normalize every read.
 */
export const list = <T>(v: T | T[] | null | undefined | "null"): T[] =>
  v == null || v === "null" ? [] : Array.isArray(v) ? v : [v];

const TRADIER_CONDITIONS: Record<string, NormalizedCondition> = {
  "": "regular", // empty flag — plain print
  cancel: "cancel", // synthesized from the timesale `cancel: true` boolean
  // A correction replaces an earlier print: the tape entry is real but its
  // timestamp cannot anchor sweep windows or side inference — late policy.
  correction: "late",
  // Outside the regular session there is no live NBBO to trust.
  "session:pre": "late",
  "session:post": "late",
};

/** One market event from wss://ws.tradier.com/v1/markets/events. */
export interface TradierTimesale {
  type?: string;
  symbol?: string;
  exch?: string;
  bid?: string | number;
  ask?: string | number;
  last?: string | number;
  size?: string | number;
  /** Epoch milliseconds, as a string. */
  date?: string | number;
  seq?: number;
  flag?: string;
  cancel?: boolean;
  correction?: boolean;
  session?: string;
}

function num(v: string | number | undefined): number {
  if (v === undefined) return Number.NaN;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * Pure mapper: one timesale event → RawOptionTrade. Returns null for
 * non-timesale events and for symbols that are not OCC option contracts
 * (the stream can interleave equity events if equities are subscribed).
 */
export function mapTradierTimesale(event: TradierTimesale): RawOptionTrade | null {
  if (event.type !== "timesale" || !event.symbol) return null;
  if (!parseOcc(event.symbol)) return null;
  const price = num(event.last);
  const size = num(event.size);
  const ts = num(event.date);
  if (!Number.isFinite(price) || !Number.isFinite(size) || !Number.isFinite(ts)) return null;

  const conditions: string[] = [];
  if (event.flag) conditions.push(event.flag);
  if (event.cancel) conditions.push("cancel");
  if (event.correction) conditions.push("correction");
  if (event.session && event.session !== "normal") conditions.push(`session:${event.session}`);

  const bid = num(event.bid);
  const ask = num(event.ask);
  const nbbo: Nbbo | null =
    Number.isFinite(bid) && Number.isFinite(ask) && ask > 0
      ? { bid, ask, bidSize: 0, askSize: 0, ts }
      : null;

  return {
    ts,
    contract: event.symbol,
    price,
    size,
    exchange: event.exch || "?",
    conditions,
    nbbo,
    spot: null,
    oi: null,
  };
}

/** One option row of GET /v1/markets/options/chains. */
export interface TradierChainOption {
  symbol?: string;
  bid?: number | null;
  ask?: number | null;
  bidsize?: number | null;
  asksize?: number | null;
  bid_date?: number | null;
  ask_date?: number | null;
  strike?: number;
  open_interest?: number | null;
  volume?: number | null;
  expiration_date?: string;
  option_type?: string;
  underlying?: string;
  greeks?: {
    delta?: number;
    gamma?: number;
    theta?: number;
    vega?: number;
    mid_iv?: number;
    smv_vol?: number;
  } | null;
}

/** Pure mapper: one chain row → ChainContract (null = unusable row). */
export function mapTradierChainOption(row: TradierChainOption): ChainContract | null {
  if (!row.symbol || !row.expiration_date || row.strike === undefined) return null;
  const parsed = parseOcc(row.symbol);
  if (!parsed) return null;
  const right: Right = row.option_type === "put" ? "P" : "C";
  const quoteTs = Math.max(row.bid_date ?? 0, row.ask_date ?? 0);
  return {
    contract: parsed.occ,
    underlying: (row.underlying ?? parsed.underlying).toUpperCase(),
    expiry: row.expiration_date,
    strike: row.strike,
    right,
    oi: row.open_interest ?? null,
    volume: row.volume ?? null,
    iv: row.greeks?.mid_iv ?? row.greeks?.smv_vol ?? null,
    greeks: row.greeks
      ? {
          delta: row.greeks.delta ?? null,
          gamma: row.greeks.gamma ?? null,
          theta: row.greeks.theta ?? null,
          vega: row.greeks.vega ?? null,
        }
      : null,
    nbbo:
      row.bid != null && row.ask != null
        ? {
            bid: row.bid,
            ask: row.ask,
            bidSize: row.bidsize ?? 0,
            askSize: row.asksize ?? 0,
            ts: quoteTs > 0 ? quoteTs : Date.now(),
          }
        : null,
  };
}

interface TradierQuote {
  symbol?: string;
  last?: number | null;
  bid?: number | null;
  ask?: number | null;
  bidsize?: number | null;
  asksize?: number | null;
  bid_date?: number | null;
  ask_date?: number | null;
}

export class TradierFeed implements FeedAdapter {
  readonly id = "tradier" as const;
  private readonly accessToken: string;
  private readonly apiBase: string;
  private readonly wsUrl: string;

  constructor(options: TradierOptions) {
    if (!options.accessToken) throw new Error("tradier feed needs an access token");
    this.accessToken = options.accessToken;
    this.apiBase = (options.apiBase ?? "https://api.tradier.com/v1").replace(/\/+$/, "");
    this.wsUrl = options.wsUrl ?? "wss://ws.tradier.com/v1/markets/events";
  }

  capabilities(): FeedCapabilities {
    // timesale events deliver bid/ask at print time (no sizes) — NBBO rides
    // on the tick. Greeks/IV come on chains courtesy of ORATS.
    return { realtime: true, greeksProvided: true, nbbo: true, conditions: true };
  }

  normalizeCondition(code: string): NormalizedCondition {
    return TRADIER_CONDITIONS[code] ?? "unknown";
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json" };
  }

  /** All listed option symbols for an underlying (subscription universe). */
  private async lookupOptionSymbols(underlying: string): Promise<string[]> {
    const url = `${this.apiBase}/markets/options/lookup?underlying=${encodeURIComponent(underlying)}`;
    const res = await fetchJson<{
      symbols?:
        | Array<{ rootSymbol?: string; options?: string[] | string | null }>
        | { rootSymbol?: string; options?: string[] | string | null }
        | null
        | "null";
    }>(url, { headers: this.headers() });
    const out: string[] = [];
    for (const root of list(res.symbols)) out.push(...list(root.options));
    return out;
  }

  private async createStreamSession(): Promise<string> {
    const res = await fetchJson<{ stream?: { sessionid?: string; url?: string } }>(
      `${this.apiBase}/markets/events/session`,
      { method: "POST", headers: this.headers() },
    );
    const sessionid = res.stream?.sessionid;
    if (!sessionid) throw new Error("tradier did not return a stream sessionid");
    return sessionid;
  }

  async *subscribeOptionTrades(
    filter: TradeFilter,
    signal?: AbortSignal,
  ): AsyncIterable<RawOptionTrade> {
    const underlyings = (filter.underlyings ?? []).map((u) => u.toUpperCase());
    if (underlyings.length === 0) {
      throw new Error(
        "tradier feed needs universe.underlyings; subscriptions are per option symbol, full-market streaming is not offered",
      );
    }
    let attempt = 0;
    while (!signal?.aborted) {
      let symbols: string[];
      let sessionid: string;
      try {
        // Session ids are single-use and short-lived; contracts list and
        // session are refreshed on every (re)connect.
        symbols = (await Promise.all(underlyings.map((u) => this.lookupOptionSymbols(u)))).flat();
        sessionid = await this.createStreamSession();
      } catch (err) {
        if (err instanceof FeedAuthError) throw err;
        if (signal?.aborted) return;
        attempt++;
        await sleep(backoffMs(attempt), signal);
        continue;
      }
      if (symbols.length === 0) {
        // Nothing listed (bad symbols?) — retry slowly rather than spin.
        attempt++;
        await sleep(backoffMs(attempt), signal);
        continue;
      }

      const queue = new AsyncQueue<RawOptionTrade>();
      const ws = new WebSocket(this.wsUrl);
      const onAbort = () => ws.close();
      signal?.addEventListener("abort", onAbort, { once: true });

      ws.on("open", () => {
        attempt = 0;
        // One payload subscribes everything. A liquid underlying can list
        // thousands of contracts (a few hundred KB of JSON) — Tradier's
        // guidance is to subscribe only what is needed, which is exactly
        // the configured universe.
        ws.send(
          JSON.stringify({
            symbols,
            sessionid,
            filter: ["timesale"],
            linebreak: true,
            validOnly: true,
          }),
        );
      });
      ws.on("message", (data) => {
        // linebreak:true separates payloads with newlines within a frame.
        for (const line of data.toString().split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let event: TradierTimesale;
          try {
            event = JSON.parse(trimmed) as TradierTimesale;
          } catch {
            continue;
          }
          const trade = mapTradierTimesale(event);
          if (trade) queue.push(trade);
        }
      });
      ws.on("error", (err) => queue.fail(err));
      ws.on("close", () => queue.end());

      try {
        for await (const trade of queue) {
          yield trade;
          if (signal?.aborted) break;
        }
      } catch (err) {
        if (err instanceof FeedAuthError) throw err;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        ws.close();
      }
      if (signal?.aborted) return;
      attempt++;
      await sleep(backoffMs(attempt), signal);
    }
  }

  async getNbbo(contract: string): Promise<Nbbo | null> {
    const parsed = parseOcc(contract);
    if (!parsed) return null;
    try {
      const url = `${this.apiBase}/markets/quotes?symbols=${encodeURIComponent(parsed.occ)}`;
      const res = await fetchJson<{
        quotes?: { quote?: TradierQuote | TradierQuote[] | null | "null" } | null;
      }>(url, { headers: this.headers() });
      const quote = list(res.quotes?.quote)[0];
      if (!quote || quote.bid == null || quote.ask == null) return null;
      const ts = Math.max(quote.bid_date ?? 0, quote.ask_date ?? 0);
      return {
        bid: quote.bid,
        ask: quote.ask,
        bidSize: quote.bidsize ?? 0,
        askSize: quote.asksize ?? 0,
        ts: ts > 0 ? ts : Date.now(),
      };
    } catch {
      return null;
    }
  }

  async getChainSnapshot(underlying: string): Promise<ChainSnapshot | null> {
    const symbol = underlying.toUpperCase();
    let expirations: string[];
    try {
      const url = `${this.apiBase}/markets/options/expirations?symbol=${encodeURIComponent(symbol)}&includeAllRoots=true&strikes=false`;
      const res = await fetchJson<{
        expirations?: { date?: string | string[] | null | "null" } | null | "null";
      }>(url, { headers: this.headers() });
      expirations = res.expirations === "null" ? [] : list(res.expirations?.date);
    } catch {
      return null;
    }
    if (expirations.length === 0) return null;

    const contracts: ChainContract[] = [];
    for (const expiration of expirations) {
      try {
        const url = `${this.apiBase}/markets/options/chains?symbol=${encodeURIComponent(symbol)}&expiration=${encodeURIComponent(expiration)}&greeks=true`;
        const res = await fetchJson<{
          options?: { option?: TradierChainOption | TradierChainOption[] | null | "null" } | null;
        }>(url, { headers: this.headers() });
        for (const row of list(res.options?.option)) {
          const contract = mapTradierChainOption(row);
          if (contract) contracts.push(contract);
        }
      } catch {
        // One bad expiration degrades that slice, not the whole chain.
      }
    }
    if (contracts.length === 0) return null;
    return { underlying: symbol, ts: Date.now(), spot: await this.getSpot(symbol), contracts };
  }

  async getSpot(underlying: string): Promise<number | null> {
    try {
      const url = `${this.apiBase}/markets/quotes?symbols=${encodeURIComponent(underlying.toUpperCase())}`;
      const res = await fetchJson<{
        quotes?: { quote?: TradierQuote | TradierQuote[] | null | "null" } | null;
      }>(url, { headers: this.headers() });
      const quote = list(res.quotes?.quote)[0];
      if (!quote) return null;
      if (quote.last != null && Number.isFinite(quote.last)) return quote.last;
      if (quote.bid != null && quote.ask != null && quote.bid > 0 && quote.ask > 0) {
        return (quote.bid + quote.ask) / 2;
      }
      return null;
    } catch {
      return null;
    }
  }
}
