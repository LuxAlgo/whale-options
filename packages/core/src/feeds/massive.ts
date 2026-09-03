/*
  Massive adapter (Polygon.io rebranded to Massive, Oct 2025 — same API and
  keys, new domains; api.polygon.io / socket.polygon.io remain live aliases).

  Trades stream over WebSocket at wss://socket.massive.com/options (delayed
  tier: wss://delayed.massive.com/options), channel "T.<underlying>" per the
  options WS docs — subscribing the bare underlying delivers every contract
  on it, "T.*" the whole market. Auth is {"action":"auth","params":KEY}.
  Trade messages: {ev:"T", sym:"O:<OCC>", x:<exchange id>, p, s,
  c:[condition ids], t:<unix ms>, q:<sequence>}.

  REST: chain snapshot GET /v3/snapshot/options/{underlying} (limit ≤ 250,
  next_url pagination) carries greeks/IV/OI/last_quote per contract; single
  contract GET /v3/snapshot/options/{u}/{O:occ} backs getNbbo; stock
  aggregates GET /v2/aggs/ticker/{symbol}/range/{mult}/{span}/{from}/{to}
  back getUnderlyingBars (a stocks entitlement, separate from options). Auth
  is the apiKey query param; responses carry {status, results, error,
  message}. Sources: https://polygon.io/docs/websocket/options/trades,
  https://polygon.io/docs/rest/options/snapshots/option-chain-snapshot,
  https://polygon.io/docs/rest/stocks/aggregates/custom-bars
  (same pages under https://massive.com/docs/ post-rebrand).
*/
import { WebSocket } from "ws";
import { parseOcc } from "../occ.js";
import type { ChainContract, ChainSnapshot, Nbbo, NormalizedCondition } from "../types.js";
import { AsyncQueue, backoffMs, FeedAuthError, fetchJson, sleep } from "./feed-util.js";
import type {
  BarRange,
  BarTimeframe,
  FeedAdapter,
  FeedCapabilities,
  RawOptionTrade,
  TradeFilter,
  UnderlyingBar,
  UnderlyingBarsResult,
} from "./types.js";

export interface MassiveOptions {
  apiKey: string;
  /** WS host tier: real-time (socket.) or 15-minute delayed (delayed.). */
  stream?: "realtime" | "delayed";
  restBase?: string;
  /** Full WS base override, e.g. wss://socket.polygon.io. */
  wsBase?: string;
}

/*
  Options trade-condition ids → normalized vocabulary. Massive/Polygon send
  numeric condition ids on options trades; the authoritative list is
  GET /v3/reference/conditions?asset_class=options (docs:
  https://polygon.io/docs/rest/options/market-operations/condition-codes).
  Ids below are that endpoint's documented options set (201–210, 219,
  227–248, mirroring OPRA's CANC…EXHT vocabulary); ids in the gaps are
  legacy/retired codes and normalize to "unknown", which the engine keeps
  but flags.
*/
const MASSIVE_CONDITIONS: Record<number, NormalizedCondition> = {
  201: "cancel", // CANC — Canceled
  202: "out-of-sequence", // OSEQ — Late and Out Of Sequence
  203: "cancel", // CNCL — Last and Canceled
  204: "late", // LATE — Late
  205: "cancel", // CNCO — Opening Trade and Canceled
  206: "out-of-sequence", // OPEN — Opening Trade, Late, and Out Of Sequence
  207: "cancel", // CNOL — Only Trade and Canceled
  208: "late", // OPNL — Opening Trade and Late
  209: "auto", // AUTO — Automatic Execution
  210: "reopening", // REOP — Reopening Trade
  219: "iso", // ISOI — Intermarket Sweep Order
  227: "auction", // SLAN — Single Leg Auction Non ISO
  228: "auction", // SLAI — Single Leg Auction ISO
  229: "cross", // SLCN — Single Leg Cross Non ISO
  230: "cross", // SLCI — Single Leg Cross ISO
  231: "floor", // SLFT — Single Leg Floor Trade
  232: "spread-leg", // MLET — Multi Leg auto-electronic trade
  233: "spread-leg", // MLAT — Multi Leg Auction
  234: "spread-leg", // MLCT — Multi Leg Cross
  235: "spread-leg", // MLFT — Multi Leg floor trade
  236: "spread-leg", // MESL — Multi Leg auto-electronic vs single leg(s)
  237: "spread-leg-equity", // TLAT — Stock Options Auction
  238: "spread-leg", // MASL — Multi Leg Auction vs single leg(s)
  239: "spread-leg", // MFSL — Multi Leg floor trade vs single leg(s)
  240: "spread-leg-equity", // TLET — Stock Options auto-electronic trade
  241: "spread-leg-equity", // TLCT — Stock Options Cross
  242: "spread-leg-equity", // TLFT — Stock Options floor trade
  243: "spread-leg-equity", // TESL — Stock Options auto-electronic vs single leg(s)
  244: "spread-leg-equity", // TASL — Stock Options Auction vs single leg(s)
  245: "spread-leg-equity", // TFSL — Stock Options floor trade vs single leg(s)
  246: "spread-leg", // CBMO — Multi Leg Floor Trade of Proprietary Products
  247: "cross", // MCTP — Multilateral Compression Trade (off-market pricing)
  248: "late", // EXHT — Extended Hours Trade
};

/*
  Numeric exchange ids (asset_class=options) → OPRA participant letters,
  from GET /v3/reference/exchanges?asset_class=options. Unknown ids pass
  through as their number — still distinct for sweep counting.
*/
const MASSIVE_EXCHANGES: Record<number, string> = {
  300: "A", // NYSE American Options
  301: "B", // BOX
  302: "C", // Cboe
  303: "D", // MIAX Emerald
  304: "E", // Cboe EDGX Options
  307: "H", // Nasdaq GEMX
  308: "I", // Nasdaq ISE
  309: "J", // Nasdaq MRX
  312: "M", // MIAX
  313: "N", // NYSE Arca Options
  314: "O", // OPRA (SIP-generated)
  315: "P", // MIAX Pearl
  316: "Q", // Nasdaq Options Market
  319: "T", // Nasdaq BX Options
  322: "W", // Cboe C2
  323: "X", // Nasdaq PHLX
  325: "Z", // Cboe BZX Options
};

/** One options trade event from the WS ("T." channel). */
export interface MassiveWsTrade {
  ev?: string;
  sym?: string;
  x?: number;
  p?: number;
  s?: number;
  c?: number[];
  t?: number;
  q?: number;
}

export function massiveExchange(code: number | undefined): string {
  if (code === undefined || code === null) return "?";
  return MASSIVE_EXCHANGES[code] ?? String(code);
}

/** Pure mapper: one WS trade event → RawOptionTrade (null = not a print). */
export function mapMassiveTrade(msg: MassiveWsTrade): RawOptionTrade | null {
  if (msg.ev !== "T" || !msg.sym) return null;
  if (msg.p === undefined || msg.s === undefined || msg.t === undefined) return null;
  return {
    ts: msg.t,
    contract: msg.sym, // "O:<OCC>" — parseOcc handles the prefix
    price: msg.p,
    size: msg.s,
    exchange: massiveExchange(msg.x),
    conditions: (msg.c ?? []).map(String),
    nbbo: null,
    spot: null,
    oi: null,
  };
}

/** One trade row of GET /v3/trades/{O:occ} (REST historical trades). Ids in
 *  `conditions`/`exchange` are the same options tables as the WS stream.
 *  Source: the official SDK models (massive/rest/models/trades.py, Trade)
 *  in https://github.com/polygon-io/client-python. */
export interface MassiveHistTrade {
  /** SIP timestamp in nanoseconds. */
  sip_timestamp?: number;
  participant_timestamp?: number;
  price?: number;
  size?: number;
  exchange?: number;
  conditions?: number[];
  sequence_number?: number;
}

/** Pure mapper: one REST trade row + its contract → RawOptionTrade. */
export function mapMassiveHistoricalTrade(
  contract: string,
  row: MassiveHistTrade,
): RawOptionTrade | null {
  if (row.price === undefined || row.size === undefined || row.sip_timestamp === undefined) {
    return null;
  }
  return {
    ts: Math.round(row.sip_timestamp / 1e6),
    contract, // "O:<OCC>" — parseOcc handles the prefix
    price: row.price,
    size: row.size,
    exchange: massiveExchange(row.exchange),
    conditions: (row.conditions ?? []).map(String),
    nbbo: null,
    spot: null,
    oi: null,
  };
}

/** One row of GET /v3/reference/options/contracts (as-of-date listing). */
export interface MassiveContractRef {
  ticker?: string;
  expiration_date?: string;
  strike_price?: number;
  contract_type?: string;
  underlying_ticker?: string;
}

interface MassiveEnvelope<T> {
  status?: string;
  results?: T;
  next_url?: string;
  error?: string;
  message?: string;
}

/** One contract row of /v3/snapshot/options/{underlying}. */
export interface MassiveChainResult {
  details?: {
    ticker?: string;
    contract_type?: string;
    expiration_date?: string;
    strike_price?: number;
  };
  day?: { volume?: number };
  greeks?: { delta?: number; gamma?: number; theta?: number; vega?: number };
  implied_volatility?: number;
  open_interest?: number;
  last_quote?: {
    bid?: number;
    ask?: number;
    bid_size?: number;
    ask_size?: number;
    last_updated?: number; // nanoseconds
  };
  underlying_asset?: { price?: number; ticker?: string };
}

/** Pure mapper: one chain-snapshot result → ChainContract (null = unusable). */
export function mapMassiveChainContract(row: MassiveChainResult): ChainContract | null {
  const details = row.details;
  if (!details?.ticker || !details.expiration_date || details.strike_price === undefined) {
    return null;
  }
  const parsed = parseOcc(details.ticker);
  if (!parsed) return null;
  const q = row.last_quote;
  return {
    contract: parsed.occ,
    underlying: parsed.underlying,
    expiry: details.expiration_date,
    strike: details.strike_price,
    right: details.contract_type === "put" ? "P" : "C",
    oi: row.open_interest ?? null,
    volume: row.day?.volume ?? null,
    iv: row.implied_volatility ?? null,
    greeks: row.greeks
      ? {
          delta: row.greeks.delta ?? null,
          gamma: row.greeks.gamma ?? null,
          theta: row.greeks.theta ?? null,
          vega: row.greeks.vega ?? null,
        }
      : null,
    nbbo:
      q && q.bid !== undefined && q.ask !== undefined
        ? {
            bid: q.bid,
            ask: q.ask,
            bidSize: q.bid_size ?? 0,
            askSize: q.ask_size ?? 0,
            ts: q.last_updated !== undefined ? Math.round(q.last_updated / 1e6) : Date.now(),
          }
        : null,
  };
}

/** One row of GET /v2/aggs/ticker/{symbol}/range/... (`results: [...]`).
 *  Keys per the aggregates docs and the SDK model (massive/rest/models/
 *  aggs.py, Agg): t (window start, unix ms), o/h/l/c, v (volume), vw (VWAP),
 *  n (transactions). */
export interface MassiveAggregate {
  t?: number;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
  vw?: number;
  n?: number;
}

/** Vela/whale timeframe → the aggregates path's {multiplier}/{timespan}. */
export const MASSIVE_BAR_RANGES: Record<BarTimeframe, { multiplier: number; timespan: string }> = {
  "1m": { multiplier: 1, timespan: "minute" },
  "5m": { multiplier: 5, timespan: "minute" },
  "15m": { multiplier: 15, timespan: "minute" },
  "1h": { multiplier: 1, timespan: "hour" },
  "1d": { multiplier: 1, timespan: "day" },
};

/** Pure mapper: one aggregate row → UnderlyingBar (null = unusable). */
export function mapMassiveAggregate(row: MassiveAggregate): UnderlyingBar | null {
  if (
    row.t === undefined ||
    row.o === undefined ||
    row.h === undefined ||
    row.l === undefined ||
    row.c === undefined
  ) {
    return null;
  }
  return { ts: row.t, open: row.o, high: row.h, low: row.l, close: row.c, volume: row.v ?? null };
}

export class MassiveFeed implements FeedAdapter {
  readonly id = "massive" as const;
  private readonly apiKey: string;
  private readonly restBase: string;
  private readonly wsBase: string;

  constructor(options: MassiveOptions) {
    if (!options.apiKey) throw new Error("massive feed needs an API key");
    this.apiKey = options.apiKey;
    this.restBase = (options.restBase ?? "https://api.massive.com").replace(/\/+$/, "");
    this.wsBase =
      options.wsBase ??
      (options.stream === "delayed" ? "wss://delayed.massive.com" : "wss://socket.massive.com");
  }

  capabilities(): FeedCapabilities {
    // NBBO is not delivered alongside WS trades — the runner looks it up via
    // getNbbo (REST snapshot), which needs a quotes-entitled plan.
    return { realtime: true, greeksProvided: true, nbbo: false, conditions: true };
  }

  normalizeCondition(code: string): NormalizedCondition {
    const n = Number(code);
    if (!Number.isInteger(n)) return "unknown";
    return MASSIVE_CONDITIONS[n] ?? "unknown";
  }

  async *subscribeOptionTrades(
    filter: TradeFilter,
    signal?: AbortSignal,
  ): AsyncIterable<RawOptionTrade> {
    const params = filter.underlyings?.length
      ? filter.underlyings.map((u) => `T.${u.toUpperCase()}`).join(",")
      : "T.*";
    let attempt = 0;
    while (!signal?.aborted) {
      const queue = new AsyncQueue<RawOptionTrade>();
      const ws = new WebSocket(`${this.wsBase}/options`);
      const onAbort = () => ws.close();
      signal?.addEventListener("abort", onAbort, { once: true });

      ws.on("open", () => {
        ws.send(JSON.stringify({ action: "auth", params: this.apiKey }));
      });
      ws.on("message", (data) => {
        let events: Array<Record<string, unknown>>;
        try {
          const parsed = JSON.parse(data.toString());
          events = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          return;
        }
        for (const event of events) {
          if (event.ev === "status") {
            const status = String(event.status ?? "");
            if (status === "auth_success") {
              attempt = 0;
              ws.send(JSON.stringify({ action: "subscribe", params }));
            } else if (status === "auth_failed") {
              queue.fail(
                new FeedAuthError(`massive websocket auth failed: ${event.message ?? ""}`),
              );
              ws.close();
            }
            continue;
          }
          const trade = mapMassiveTrade(event as MassiveWsTrade);
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
        if (err instanceof FeedAuthError) throw err; // bad key — do not spin
      } finally {
        signal?.removeEventListener("abort", onAbort);
        ws.close();
      }
      if (signal?.aborted) return;
      attempt++;
      await sleep(backoffMs(attempt), signal);
    }
  }

  private withKey(url: string): string {
    return `${url}${url.includes("?") ? "&" : "?"}apiKey=${this.apiKey}`;
  }

  async getNbbo(contract: string): Promise<Nbbo | null> {
    const parsed = parseOcc(contract);
    if (!parsed) return null;
    try {
      const url = this.withKey(
        `${this.restBase}/v3/snapshot/options/${parsed.underlying}/O:${parsed.occ}`,
      );
      const res = await fetchJson<MassiveEnvelope<MassiveChainResult>>(url);
      const q = res.results?.last_quote;
      if (!q || q.bid === undefined || q.ask === undefined) return null;
      return {
        bid: q.bid,
        ask: q.ask,
        bidSize: q.bid_size ?? 0,
        askSize: q.ask_size ?? 0,
        ts: q.last_updated !== undefined ? Math.round(q.last_updated / 1e6) : Date.now(),
      };
    } catch {
      return null;
    }
  }

  async getChainSnapshot(underlying: string): Promise<ChainSnapshot | null> {
    const symbol = underlying.toUpperCase();
    const contracts: ChainContract[] = [];
    let spot: number | null = null;
    let url: string | null = this.withKey(
      `${this.restBase}/v3/snapshot/options/${symbol}?limit=250`,
    );
    let pages = 0;
    try {
      while (url && pages < 100) {
        pages++;
        const res: MassiveEnvelope<MassiveChainResult[]> =
          await fetchJson<MassiveEnvelope<MassiveChainResult[]>>(url);
        for (const row of res.results ?? []) {
          const contract = mapMassiveChainContract(row);
          if (contract) contracts.push(contract);
          if (spot === null && typeof row.underlying_asset?.price === "number") {
            spot = row.underlying_asset.price;
          }
        }
        url = res.next_url ? this.withKey(res.next_url) : null;
      }
    } catch {
      if (contracts.length === 0) return null;
    }
    if (contracts.length === 0) return null;
    return { underlying: symbol, ts: Date.now(), spot, contracts };
  }

  async getSpot(underlying: string): Promise<number | null> {
    // The chain snapshot rides the options entitlement and reports the
    // underlying price on each row — one-row page keeps the call cheap.
    try {
      const url = this.withKey(
        `${this.restBase}/v3/snapshot/options/${underlying.toUpperCase()}?limit=1`,
      );
      const res = await fetchJson<MassiveEnvelope<MassiveChainResult[]>>(url);
      const price = res.results?.[0]?.underlying_asset?.price;
      return typeof price === "number" && Number.isFinite(price) ? price : null;
    } catch {
      return null;
    }
  }

  /**
   * Stock aggregates via GET /v2/aggs/ticker/{symbol}/range/{mult}/{span}/
   * {from}/{to}?adjusted=true&sort=asc&limit=50000 (from/to accept unix ms;
   * next_url pagination). Needs a stocks entitlement — an options-only key
   * gets 403 and this returns null so the API falls back to the spot tape.
   */
  async getUnderlyingBars(
    symbol: string,
    timeframe: BarTimeframe,
    range: BarRange,
  ): Promise<UnderlyingBarsResult | null> {
    const { multiplier, timespan } = MASSIVE_BAR_RANGES[timeframe];
    const bars: UnderlyingBar[] = [];
    let url: string | null = this.withKey(
      `${this.restBase}/v2/aggs/ticker/${symbol.toUpperCase()}/range/${multiplier}/${timespan}/${Math.floor(range.from)}/${Math.ceil(range.to)}?adjusted=true&sort=asc&limit=50000`,
    );
    let pages = 0;
    try {
      while (url && pages < 20) {
        pages++;
        const res: MassiveEnvelope<MassiveAggregate[]> =
          await fetchJson<MassiveEnvelope<MassiveAggregate[]>>(url);
        for (const row of res.results ?? []) {
          const bar = mapMassiveAggregate(row);
          if (bar) bars.push(bar);
        }
        url = res.next_url ? this.withKey(res.next_url) : null;
      }
    } catch {
      return null;
    }
    return {
      bars,
      source: "massive stock aggregates (adjusted=true)",
      note: "bars from Massive's stock aggregates endpoint: consolidated SIP bars, split-adjusted (adjusted=true); delayed on the entry stocks tier, real-time on advanced",
    };
  }

  /** All contract tickers listed on the underlying as of a date — both the
   *  still-active and the since-expired sets, via the reference endpoint
   *  (GET /v3/reference/options/contracts?underlying_ticker&as_of&expired).
   *  Source: massive/rest/reference.py (list_options_contracts) in
   *  https://github.com/polygon-io/client-python. */
  private async listContractsAsOf(
    underlying: string,
    dateIso: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const tickers: string[] = [];
    for (const expired of ["false", "true"]) {
      let url: string | null = this.withKey(
        `${this.restBase}/v3/reference/options/contracts?underlying_ticker=${underlying}&as_of=${dateIso}&expired=${expired}&limit=1000`,
      );
      let pages = 0;
      while (url && pages < 25) {
        pages++;
        const res: MassiveEnvelope<MassiveContractRef[]> = await fetchJson<
          MassiveEnvelope<MassiveContractRef[]>
        >(url, { signal });
        for (const row of res.results ?? []) {
          if (row.ticker) tickers.push(row.ticker);
        }
        url = res.next_url ? this.withKey(res.next_url) : null;
      }
    }
    return [...new Set(tickers)];
  }

  /**
   * Historical option trades for one session. There is no trades-by-underlying
   * historical surface — GET /v3/trades/{ticker} is per OCC contract
   * (timestamp=YYYY-MM-DD selects the session; source: massive/rest/trades.py
   * in https://github.com/polygon-io/client-python) — so the chain's contracts
   * as of that date are enumerated and iterated. COST: a liquid underlying
   * lists thousands of contracts, i.e. thousands of REST calls per session;
   * the hard caps below bound the worst case, favoring near-listing contracts
   * (the reference endpoint pages in ticker order). Trades are buffered and
   * merge-sorted into time order before yielding, as the adapter contract
   * requires — one session of one underlying fits comfortably in memory.
   */
  async *getHistoricalOptionTrades(
    underlying: string,
    dateIso: string,
    signal?: AbortSignal,
  ): AsyncIterable<RawOptionTrade> {
    const symbol = underlying.toUpperCase();
    // Hard caps: at most this many contracts per (date × underlying), and at
    // most this many 50k-row pages per contract, keep a full-chain session
    // from turning into an unbounded REST crawl.
    const maxContracts = 2_500;
    const maxPagesPerContract = 10;
    const tickers = (await this.listContractsAsOf(symbol, dateIso, signal)).slice(0, maxContracts);
    const trades: RawOptionTrade[] = [];
    for (const ticker of tickers) {
      if (signal?.aborted) return;
      let url: string | null = this.withKey(
        `${this.restBase}/v3/trades/${ticker}?timestamp=${dateIso}&order=asc&sort=timestamp&limit=50000`,
      );
      let pages = 0;
      try {
        while (url && pages < maxPagesPerContract) {
          pages++;
          const res: MassiveEnvelope<MassiveHistTrade[]> = await fetchJson<
            MassiveEnvelope<MassiveHistTrade[]>
          >(url, { signal });
          for (const row of res.results ?? []) {
            const trade = mapMassiveHistoricalTrade(ticker, row);
            if (trade) trades.push(trade);
          }
          url = res.next_url ? this.withKey(res.next_url) : null;
        }
      } catch (err) {
        if (err instanceof FeedAuthError) throw err; // fix the key, not skip
        // One contract's history degrades; the rest of the chain still folds.
      }
    }
    trades.sort((a, b) => a.ts - b.ts);
    for (const trade of trades) {
      if (signal?.aborted) return;
      yield trade;
    }
  }

  /**
   * As-of-date chain: not offered. The snapshot endpoint used by
   * getChainSnapshot is current-state only, and no documented endpoint
   * returns open interest as of a past date — so this returns null rather
   * than fabricating OI history from current snapshots. OI-delta/IV history
   * for massive accrues from live sessions' chain refreshes instead.
   */
  async getHistoricalChain(): Promise<ChainSnapshot | null> {
    return null;
  }
}
