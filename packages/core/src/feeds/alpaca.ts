/*
  Alpaca adapter — options market data (https://docs.alpaca.markets/docs/
  real-time-option-data). The options stream lives under
  wss://stream.data.alpaca.markets/v1beta1/{feed} with feed "indicative"
  (free with signup; derived quotes/trades) or "opra" (Algo Trader Plus).
  The options stream is msgpack-only, hence the local codec in msgpack.ts.

  Protocol: connect → [{"T":"success","msg":"connected"}] → send
  {action:"auth", key, secret} → [{"T":"success","msg":"authenticated"}] →
  {action:"subscribe", trades:[...]}. Option trade events are
  {T:"t", S:"<OCC>", t:<timestamp>, p, s, x:"<exchange letter>",
  c:"<condition letter>"}. Alpaca does not document per-underlying channel
  wildcards for options, so the adapter subscribes "T"rades on "*" and
  filters client-side by the parsed underlying.

  REST (https://data.alpaca.markets): option chain snapshots with greeks/IV
  at /v1beta1/options/snapshots/{underlying} (no open interest — oi stays
  null), latest option quote for getNbbo, and the free IEX stock quote for
  getSpot. Auth: APCA-API-KEY-ID / APCA-API-SECRET-KEY headers.
*/
import { WebSocket } from "ws";
import { parseOcc } from "../occ.js";
import type { ChainContract, ChainSnapshot, Nbbo, NormalizedCondition } from "../types.js";
import { easternTimeToUtc } from "../util/session.js";
import { AsyncQueue, backoffMs, FeedAuthError, fetchJson, sleep } from "./feed-util.js";
import { type MsgpackValue, msgpackDecode, msgpackEncode } from "./msgpack.js";
import type { FeedAdapter, FeedCapabilities, RawOptionTrade, TradeFilter } from "./types.js";

export interface AlpacaOptions {
  keyId: string;
  secretKey: string;
  /** Options feed: "indicative" (free tier) or "opra" (paid subscription). */
  stream?: "indicative" | "opra";
  dataBase?: string;
  streamBase?: string;
}

/*
  Condition letters → normalized vocabulary. Alpaca relays OPRA's
  single-character trade conditions verbatim (their own map is served by
  GET /v1beta1/options/meta/conditions/trade; the examples in Alpaca's
  OpenAPI spec — a=SLAN, e=SLFT, g=MLAT, trade sample c:"I" — match OPRA).
  Letter meanings per the OPRA Pillar participant spec (Equity and Index
  Last Sale message types A–J, S, a–v). Case is significant.
  Sources: https://docs.alpaca.markets/reference/optionmetaconditions,
  https://github.com/alpacahq/alpaca-trade-api-js (tooling/specs/
  market-data-api.json, option_conditions), OPRA Pillar spec via
  https://github.com/jamesbomer/opra_plugin (packet-opra.c).
*/
const ALPACA_CONDITIONS: Record<string, NormalizedCondition> = {
  A: "cancel", // CANC — previously reported, now cancelled
  B: "out-of-sequence", // OSEQ — reported late and out of sequence
  C: "cancel", // CNCL — last report, now cancelled
  D: "late", // LATE — reported late but in sequence
  E: "cancel", // CNCO — first report of day, now cancelled
  F: "out-of-sequence", // OPEN — late report of opening trade, out of sequence
  G: "cancel", // CNOL — only report of day, now cancelled
  H: "late", // OPNL — late report of opening trade, in sequence
  I: "auto", // AUTO — executed electronically
  J: "reopening", // REOP — reopening after halt
  S: "iso", // ISOI — intermarket sweep order execution
  a: "auction", // SLAN — single-leg auction, non-ISO
  b: "auction", // SLAI — single-leg auction, ISO
  c: "cross", // SLCN — single-leg cross, non-ISO
  d: "cross", // SLCI — single-leg cross, ISO
  e: "floor", // SLFT — single-leg floor trade
  f: "spread-leg", // MLET — multi-leg auto-electronic
  g: "spread-leg", // MLAT — multi-leg auction
  h: "spread-leg", // MLCT — multi-leg cross
  i: "spread-leg", // MLFT — multi-leg floor
  j: "spread-leg", // MESL — multi-leg auto-electronic vs single leg(s)
  k: "spread-leg-equity", // TLAT — stock-options auction
  l: "spread-leg", // MASL — multi-leg auction vs single leg(s)
  m: "spread-leg", // MFSL — multi-leg floor vs single leg(s)
  n: "spread-leg-equity", // TLET — stock-options auto-electronic
  o: "spread-leg-equity", // TLCT — stock-options cross
  p: "spread-leg-equity", // TLFT — stock-options floor
  q: "spread-leg-equity", // TESL — stock-options auto-electronic vs single leg(s)
  r: "spread-leg-equity", // TASL — stock-options auction vs single leg(s)
  s: "spread-leg-equity", // TFSL — stock-options floor vs single leg(s)
  t: "spread-leg", // CBMO — multi-leg floor, proprietary products
  u: "cross", // MCTP — multilateral compression, off-market pricing
  v: "late", // EXHT — extended-hours trade, session NBBO not live
  // Legacy pre-Pillar OPRA letters, kept for older recordings.
  // VERIFY: retired from the current OPRA spec; letter assignments per the
  // legacy OPRA participant spec.
  K: "regular", // AJST — adjusted-terms contract, processes as regular
  L: "spread-leg", // SPRD — part of a spread order
  M: "spread-leg", // STDL — part of a straddle order
  N: "regular", // STPD — stopped order, processes as regular
  O: "cancel", // CSTP — cancel stopped transaction
  P: "spread-leg-equity", // BWRT — buy-write (option leg tied to stock)
  Q: "spread-leg", // CMBO — part of a combo order
  R: "regular", // SPIM — stopped in market, processes as regular
  T: "cross", // BNMT — benchmark trade, price not from the live market
  X: "regular", // XMPT — trade-through exempt, treat as regular
};

/** One option trade event from the stream (msgpack-decoded). */
export interface AlpacaWsTrade {
  T?: string;
  S?: string;
  /** Epoch ms (msgpack timestamp ext) or RFC3339 string. */
  t?: number | string;
  p?: number;
  s?: number;
  x?: string;
  c?: string | string[];
}

function toEpochMs(t: number | string | undefined): number {
  if (typeof t === "number") return t;
  if (typeof t === "string") return Date.parse(t);
  return Number.NaN;
}

/** Pure mapper: one stream trade event → RawOptionTrade (null = not a print). */
export function mapAlpacaTrade(msg: AlpacaWsTrade): RawOptionTrade | null {
  if (msg.T !== "t" || !msg.S) return null;
  if (msg.p === undefined || msg.s === undefined) return null;
  const ts = toEpochMs(msg.t);
  if (!Number.isFinite(ts)) return null;
  const conditions = Array.isArray(msg.c) ? msg.c : msg.c ? [msg.c] : [];
  return {
    ts,
    contract: msg.S,
    price: msg.p,
    size: msg.s,
    exchange: msg.x ?? "?",
    conditions,
    nbbo: null,
    spot: null,
    oi: null,
  };
}

interface AlpacaQuote {
  t?: string;
  bp?: number;
  bs?: number;
  ap?: number;
  as?: number;
}

interface AlpacaSnapshot {
  latestQuote?: AlpacaQuote;
  impliedVolatility?: number;
  greeks?: { delta?: number; gamma?: number; theta?: number; vega?: number; rho?: number };
}

/** Pure mapper: one snapshots-map entry → ChainContract (null = unusable). */
export function mapAlpacaChainContract(symbol: string, snap: AlpacaSnapshot): ChainContract | null {
  const parsed = parseOcc(symbol);
  if (!parsed) return null;
  const q = snap.latestQuote;
  return {
    contract: parsed.occ,
    underlying: parsed.underlying,
    expiry: parsed.expiry,
    strike: parsed.strike,
    right: parsed.right,
    oi: null, // Alpaca's snapshots carry no open interest
    iv: snap.impliedVolatility ?? null,
    greeks: snap.greeks
      ? {
          delta: snap.greeks.delta ?? null,
          gamma: snap.greeks.gamma ?? null,
          theta: snap.greeks.theta ?? null,
          vega: snap.greeks.vega ?? null,
        }
      : null,
    nbbo:
      q && q.bp !== undefined && q.ap !== undefined
        ? {
            bid: q.bp,
            ask: q.ap,
            bidSize: q.bs ?? 0,
            askSize: q.as ?? 0,
            ts: q.t ? Date.parse(q.t) : Date.now(),
          }
        : null,
  };
}

/** One trade row of GET /v1beta1/options/trades (keyed by contract symbol).
 *  Same raw keys as the stream: t/p/s/x/c. Source: the official SDK
 *  (alpaca/data/historical/option.py get_option_trades + models/trades.py)
 *  in https://github.com/alpacahq/alpaca-py. */
export interface AlpacaHistTrade {
  /** RFC3339 timestamp string. */
  t?: string | number;
  p?: number;
  s?: number;
  x?: string;
  c?: string | string[];
}

/** Pure mapper: one historical trade row + its symbol → RawOptionTrade. */
export function mapAlpacaHistoricalTrade(
  symbol: string,
  row: AlpacaHistTrade,
): RawOptionTrade | null {
  if (row.p === undefined || row.s === undefined) return null;
  const ts = toEpochMs(row.t);
  if (!Number.isFinite(ts)) return null;
  const conditions = Array.isArray(row.c) ? row.c : row.c ? [row.c] : [];
  return {
    ts,
    contract: symbol,
    price: row.p,
    size: row.s,
    exchange: row.x ?? "?",
    conditions,
    nbbo: null,
    spot: null,
    oi: null,
  };
}

export class AlpacaFeed implements FeedAdapter {
  readonly id = "alpaca" as const;
  private readonly keyId: string;
  private readonly secretKey: string;
  private readonly stream: "indicative" | "opra";
  private readonly dataBase: string;
  private readonly streamBase: string;

  constructor(options: AlpacaOptions) {
    if (!options.keyId || !options.secretKey) throw new Error("alpaca feed needs API credentials");
    this.keyId = options.keyId;
    this.secretKey = options.secretKey;
    this.stream = options.stream ?? "indicative";
    this.dataBase = (options.dataBase ?? "https://data.alpaca.markets").replace(/\/+$/, "");
    this.streamBase = (options.streamBase ?? "wss://stream.data.alpaca.markets").replace(
      /\/+$/,
      "",
    );
  }

  capabilities(): FeedCapabilities {
    // NBBO is not attached to stream trades; the runner fetches it via
    // getNbbo (latest option quote). Greeks/IV ride on chain snapshots.
    return { realtime: true, greeksProvided: true, nbbo: false, conditions: true };
  }

  normalizeCondition(code: string): NormalizedCondition {
    // Case is significant: "a" (SLAN) and "A" (CANC) are different codes.
    return ALPACA_CONDITIONS[code] ?? "unknown";
  }

  async *subscribeOptionTrades(
    filter: TradeFilter,
    signal?: AbortSignal,
  ): AsyncIterable<RawOptionTrade> {
    const wanted = new Set((filter.underlyings ?? []).map((u) => u.toUpperCase()));
    let attempt = 0;
    while (!signal?.aborted) {
      const queue = new AsyncQueue<RawOptionTrade>();
      const ws = new WebSocket(`${this.streamBase}/v1beta1/${this.stream}`, {
        headers: { "Content-Type": "application/msgpack" },
      });
      const onAbort = () => ws.close();
      signal?.addEventListener("abort", onAbort, { once: true });

      ws.on("message", (data) => {
        let decoded: MsgpackValue;
        try {
          // ws hands back Buffer, Buffer[] (fragmented frame) or ArrayBuffer.
          const bytes = Array.isArray(data)
            ? Buffer.concat(data)
            : data instanceof Buffer
              ? data
              : Buffer.from(data as ArrayBuffer);
          decoded = msgpackDecode(bytes);
        } catch {
          return;
        }
        const events = Array.isArray(decoded) ? decoded : [decoded];
        for (const raw of events) {
          if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
          const event = raw as Record<string, MsgpackValue>;
          const kind = event.T;
          if (kind === "success") {
            if (event.msg === "connected") {
              ws.send(msgpackEncode({ action: "auth", key: this.keyId, secret: this.secretKey }));
            } else if (event.msg === "authenticated") {
              attempt = 0;
              ws.send(msgpackEncode({ action: "subscribe", trades: ["*"] }));
            }
            continue;
          }
          if (kind === "error") {
            const message = `alpaca stream error ${event.code ?? ""}: ${event.msg ?? ""}`;
            const authCodes = new Set([401, 402, 403, 404, 406, 409, 410, 411]);
            if (typeof event.code === "number" && authCodes.has(event.code)) {
              queue.fail(new FeedAuthError(message));
              ws.close();
            }
            continue;
          }
          if (kind !== "t") continue;
          const trade = mapAlpacaTrade(event as AlpacaWsTrade);
          if (!trade) continue;
          if (wanted.size > 0) {
            const parsed = parseOcc(trade.contract);
            if (!parsed || !wanted.has(parsed.underlying)) continue;
          }
          queue.push(trade);
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
        if (err instanceof FeedAuthError) throw err; // fix the keys, not retry
      } finally {
        signal?.removeEventListener("abort", onAbort);
        ws.close();
      }
      if (signal?.aborted) return;
      attempt++;
      await sleep(backoffMs(attempt), signal);
    }
  }

  private headers(): Record<string, string> {
    return {
      "APCA-API-KEY-ID": this.keyId,
      "APCA-API-SECRET-KEY": this.secretKey,
      Accept: "application/json",
    };
  }

  async getNbbo(contract: string): Promise<Nbbo | null> {
    const parsed = parseOcc(contract);
    if (!parsed) return null;
    try {
      const url = `${this.dataBase}/v1beta1/options/quotes/latest?symbols=${parsed.occ}&feed=${this.stream}`;
      const res = await fetchJson<{ quotes?: Record<string, AlpacaQuote> }>(url, {
        headers: this.headers(),
      });
      const q = res.quotes?.[parsed.occ];
      if (!q || q.bp === undefined || q.ap === undefined) return null;
      return {
        bid: q.bp,
        ask: q.ap,
        bidSize: q.bs ?? 0,
        askSize: q.as ?? 0,
        ts: q.t ? Date.parse(q.t) : Date.now(),
      };
    } catch {
      return null;
    }
  }

  async getChainSnapshot(underlying: string): Promise<ChainSnapshot | null> {
    const symbol = underlying.toUpperCase();
    const contracts: ChainContract[] = [];
    let pageToken: string | null = null;
    let pages = 0;
    try {
      do {
        pages++;
        const params = new URLSearchParams({ feed: this.stream, limit: "1000" });
        if (pageToken) params.set("page_token", pageToken);
        const url = `${this.dataBase}/v1beta1/options/snapshots/${symbol}?${params}`;
        const res = await fetchJson<{
          snapshots?: Record<string, AlpacaSnapshot>;
          next_page_token?: string | null;
        }>(url, { headers: this.headers() });
        for (const [occ, snap] of Object.entries(res.snapshots ?? {})) {
          const contract = mapAlpacaChainContract(occ, snap);
          if (contract) contracts.push(contract);
        }
        pageToken = res.next_page_token ?? null;
      } while (pageToken && pages < 50);
    } catch {
      if (contracts.length === 0) return null;
    }
    if (contracts.length === 0) return null;
    return { underlying: symbol, ts: Date.now(), spot: await this.getSpot(symbol), contracts };
  }

  async getSpot(underlying: string): Promise<number | null> {
    const symbol = underlying.toUpperCase();
    try {
      const url = `${this.dataBase}/v2/stocks/${symbol}/quotes/latest?feed=iex`;
      const res = await fetchJson<{ quote?: { bp?: number; ap?: number } }>(url, {
        headers: this.headers(),
      });
      const q = res.quote;
      if (q?.bp !== undefined && q.ap !== undefined && q.bp > 0 && q.ap > 0) {
        return (q.bp + q.ap) / 2;
      }
    } catch {
      // fall through to the latest trade
    }
    try {
      const url = `${this.dataBase}/v2/stocks/${symbol}/trades/latest?feed=iex`;
      const res = await fetchJson<{ trade?: { p?: number } }>(url, { headers: this.headers() });
      const p = res.trade?.p;
      return p !== undefined && Number.isFinite(p) ? p : null;
    } catch {
      return null;
    }
  }

  /** Contract symbols currently listed on an underlying, via the snapshots
   *  endpoint (symbols only; payload fields ignored). */
  private async listContractSymbols(underlying: string): Promise<string[]> {
    const symbols: string[] = [];
    let pageToken: string | null = null;
    let pages = 0;
    do {
      pages++;
      const params = new URLSearchParams({ feed: this.stream, limit: "1000" });
      if (pageToken) params.set("page_token", pageToken);
      const url = `${this.dataBase}/v1beta1/options/snapshots/${underlying}?${params}`;
      const res = await fetchJson<{
        snapshots?: Record<string, AlpacaSnapshot>;
        next_page_token?: string | null;
      }>(url, { headers: this.headers() });
      symbols.push(...Object.keys(res.snapshots ?? {}));
      pageToken = res.next_page_token ?? null;
    } while (pageToken && pages < 50);
    return symbols;
  }

  /**
   * Historical option trades for one session, via
   * GET /v1beta1/options/trades?symbols=...&start&end (page_token pagination,
   * sort=asc; source: alpaca/data/historical/option.py get_option_trades in
   * https://github.com/alpacahq/alpaca-py). The endpoint is per contract
   * symbol, so the universe is enumerated from the snapshots endpoint first —
   * the data API has no as-of-date contract listing, which means contracts
   * that have already expired by the time backfill runs cannot be recovered;
   * a recent backfill window is mostly intact, older sessions thin out.
   * Trades come back keyed per symbol, so they are buffered and merge-sorted
   * into time order before yielding, as the adapter contract requires.
   */
  async *getHistoricalOptionTrades(
    underlying: string,
    dateIso: string,
    signal?: AbortSignal,
  ): AsyncIterable<RawOptionTrade> {
    const symbol = underlying.toUpperCase();
    const contracts = await this.listContractSymbols(symbol);
    // Session bounds in UTC: the Eastern calendar day, midnight to midnight.
    const start = new Date(easternTimeToUtc(dateIso, 0)).toISOString();
    const end = new Date(easternTimeToUtc(dateIso, 24)).toISOString();
    const trades: RawOptionTrade[] = [];
    const batchSize = 100; // keep the symbols= query comfortably under URL limits
    for (let i = 0; i < contracts.length; i += batchSize) {
      if (signal?.aborted) return;
      const batch = contracts.slice(i, i + batchSize).join(",");
      let pageToken: string | null = null;
      let pages = 0;
      do {
        pages++;
        const params = new URLSearchParams({
          symbols: batch,
          start,
          end,
          limit: "10000",
          sort: "asc",
        });
        if (pageToken) params.set("page_token", pageToken);
        const url = `${this.dataBase}/v1beta1/options/trades?${params}`;
        const res = await fetchJson<{
          trades?: Record<string, AlpacaHistTrade[]>;
          next_page_token?: string | null;
        }>(url, { headers: this.headers(), signal });
        for (const [occ, rows] of Object.entries(res.trades ?? {})) {
          for (const row of rows) {
            const trade = mapAlpacaHistoricalTrade(occ, row);
            if (trade) trades.push(trade);
          }
        }
        pageToken = res.next_page_token ?? null;
      } while (pageToken && pages < 200 && !signal?.aborted);
    }
    trades.sort((a, b) => a.ts - b.ts);
    for (const trade of trades) {
      if (signal?.aborted) return;
      yield trade;
    }
  }

  /**
   * As-of-date chain: not offered — Alpaca's option snapshots carry no open
   * interest at all, and there is no historical chain endpoint, so this
   * returns null rather than fabricating OI/IV history. Baseline volumes
   * still warm from getHistoricalOptionTrades; OI-dependent context accrues
   * from live sessions instead.
   */
  async getHistoricalChain(): Promise<ChainSnapshot | null> {
    return null;
  }
}
