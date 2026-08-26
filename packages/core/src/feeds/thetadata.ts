/*
  ThetaData adapter — talks to the user's locally running Theta Terminal.

  Terminal v3 (current, verified 2026-08): REST on http://127.0.0.1:25503/v3
  and WebSocket streaming on ws://127.0.0.1:25520/v1/events. The v2 terminal
  (REST on :25510/v2) is legacy and not targeted here. Auth happens at
  terminal launch, so this adapter needs no API-key env; THETADATA_BASE_URL /
  THETADATA_WS_URL override the local defaults (e.g. terminal in Docker).
  Sources: https://docs.thetadata.us/ (v3 REST + openapiv3.yaml),
  https://docs.thetadata.us/Streaming/Getting-Started.html (WS).

  Streaming: the terminal's full-trade stream (STREAM_BULK / OPTION / TRADE)
  delivers every OPRA print; the per-underlying filter is applied client-side
  because the terminal subscribes per-contract or full-universe, nothing in
  between. Interleaved QUOTE events (the terminal sends NBBO context around
  full-stream trades) are cached per contract and attached as the print's
  NBBO. Entitlements: streaming needs a Standard+ options subscription;
  snapshot trade=Standard, quote/OI=Value, greeks=Professional — enrichment
  degrades to nulls where the account tier stops.
*/
import { WebSocket } from "ws";
import { formatOcc, parseOcc } from "../occ.js";
import type { ChainContract, ChainSnapshot, Nbbo, NormalizedCondition, Right } from "../types.js";
import { easternOffsetMs, easternTimeToUtc } from "../util/session.js";
import { AsyncQueue, backoffMs, fetchText, parseNdjson, sleep } from "./feed-util.js";
import type { FeedAdapter, FeedCapabilities, RawOptionTrade, TradeFilter } from "./types.js";

export interface ThetadataOptions {
  /** Terminal REST base, default http://127.0.0.1:25503 (v3 appended). */
  baseUrl?: string;
  /** Terminal stream endpoint, default ws://127.0.0.1:25520/v1/events. */
  wsUrl?: string;
}

/*
  Trade-condition table. ThetaData reports one integer condition per print.
  Source: https://docs.thetadata.us/Articles/Errors-Exchanges-Conditions/Trade-Conditions.html
  (linked from every v3 trade response schema in https://docs.thetadata.us/openapiv3.yaml),
  cross-checked against the official SDK enum
  https://github.com/ThetaData-API/thetadata-python (thetadata/enums.py,
  TradeCondition) and against live v3 doc samples (18 = auto execution,
  130 = multi-leg auto-electronic). Codes not listed are equity/futures
  conditions that do not occur on the OPRA tape — they normalize to
  "unknown", which the engine keeps but flags.
*/
const THETA_CONDITIONS: Record<number, NormalizedCondition> = {
  0: "regular", // REGULAR
  1: "late", // FORM_T — extended-hours print, session timestamp unreliable
  2: "out-of-sequence", // OUT_OF_SEQ
  5: "late", // OPEN_REPORT_LATE
  6: "out-of-sequence", // OPEN_REPORT_OUT_OF_SEQ
  7: "late", // OPEN_REPORT_IN_SEQ — late report of the opening print
  13: "late", // SOLD_LAST — late report
  18: "auto", // AUTO_EXECUTION
  21: "reopening", // REOPEN
  34: "regular", // ADJ_TERMS — adjusted contract, processes as a regular trade
  35: "spread-leg", // SPREAD
  36: "spread-leg", // STRADDLE
  37: "spread-leg-equity", // BUY_WRITE — option leg tied to a stock trade
  38: "spread-leg", // COMBO
  39: "regular", // STPD — stopped order, processes as a regular trade
  40: "cancel", // CANC
  41: "cancel", // CANC_LAST
  42: "cancel", // CANC_OPEN
  43: "cancel", // CANC_ONLY
  44: "cancel", // CANC_STPD
  92: "auction", // CLOSING_AUCTION
  95: "iso", // INTERMARKET_SWEEP
  97: "reopening", // REOPENING
  105: "spread-leg-equity", // STOCK_OPTION — tied-to-stock print
  106: "regular", // STOPPED_IM — stopped in market, processes as regular
  107: "cross", // BENCHMARK — price not derived from the live market
  108: "regular", // TRADE_THRU_EXEMPT — treat like a regular trade
  118: "late", // OPRA_EXT_HOURS — outside regular session, NBBO not live
  124: "cross", // QUALIFIED_CONTINGENT_TRADE — tied trade, not aggressive flow
  125: "auction", // SLAN single-leg auction non-ISO
  126: "auction", // SLAI single-leg auction ISO (auction mechanism dominates)
  127: "cross", // SLCN single-leg cross non-ISO
  128: "cross", // SLCI single-leg cross ISO
  129: "floor", // SLFT single-leg floor trade
  130: "spread-leg", // MLET multi-leg auto-electronic
  131: "spread-leg", // MLAT multi-leg auction
  132: "spread-leg", // MLCT multi-leg cross
  133: "spread-leg", // MLFT multi-leg floor
  134: "spread-leg", // MESL multi-leg auto-electronic vs single leg(s)
  135: "spread-leg-equity", // TLAT stock-options auction
  136: "spread-leg", // MASL multi-leg auction vs single leg(s)
  137: "spread-leg", // MFSL multi-leg floor vs single leg(s)
  138: "spread-leg-equity", // TLET stock-options auto-electronic
  139: "spread-leg-equity", // TLCT stock-options cross
  140: "spread-leg-equity", // TLFT stock-options floor
  141: "spread-leg-equity", // TESL stock-options auto-electronic vs single leg(s)
  142: "spread-leg-equity", // TASL stock-options auction vs single leg(s)
  143: "spread-leg-equity", // TFSL stock-options floor vs single leg(s)
  144: "spread-leg", // CBMO multi-leg floor, proprietary products
  147: "cross", // MCTP multilateral compression — prices derived off-market
  148: "late", // EXHT extended-hours trade
};

/*
  Exchange ints → OPRA participant letters, for the options venues. Source:
  the official SDK Exchange enum (thetadata-python enums.py), consistent with
  live v3 samples (65 = EDGX, 22 = MRX).
  VERIFY: https://docs.thetadata.us/Articles/Errors-Exchanges-Conditions/Exchanges.html
  is the authoritative current list (unreachable from this environment).
*/
const THETA_EXCHANGES: Record<number, string> = {
  1: "Q", // Nasdaq (NOM)
  4: "A", // NYSE American
  5: "C", // Cboe
  6: "I", // Nasdaq ISE
  7: "N", // NYSE Arca
  9: "X", // Nasdaq PHLX
  10: "O", // OPRA (SIP-generated)
  11: "B", // BOX
  22: "J", // Nasdaq MRX (Mercury)
  31: "H", // Nasdaq GEMX (Gemini)
  42: "W", // Cboe C2
  43: "M", // MIAX
  47: "T", // Nasdaq BX
  60: "Z", // Cboe BZX (BATS)
  65: "E", // Cboe EDGX
  69: "P", // MIAX Pearl
  73: "U", // MEMX
};

/** One frame from ws://…:25520/v1/events (header + contract + payload). */
export interface ThetaStreamMessage {
  header?: { type?: string; status?: string };
  contract?: {
    security_type?: string;
    root?: string;
    expiration?: number;
    strike?: number;
    right?: string;
  };
  trade?: {
    ms_of_day?: number;
    sequence?: number;
    size?: number;
    condition?: number;
    price?: number;
    exchange?: number;
    date?: number;
  };
  quote?: {
    ms_of_day?: number;
    bid_size?: number;
    bid_exchange?: number;
    bid?: number;
    bid_condition?: number;
    ask_size?: number;
    ask_exchange?: number;
    ask?: number;
    ask_condition?: number;
    date?: number;
  };
}

/** YYYYMMDD int → ISO date string; null when malformed. */
export function thetaDateToIso(date: number | undefined): string | null {
  if (!date || !Number.isInteger(date)) return null;
  const s = String(date);
  if (s.length !== 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/**
 * Terminal times are Eastern wall-clock: a YYYYMMDD date plus ms since
 * midnight ET. Anchoring at midnight keeps DST handling exact for anything
 * inside the trading session (the 02:00 switch never overlaps trading).
 */
export function thetaTimestampToUtc(date: number, msOfDay: number): number {
  const iso = thetaDateToIso(date);
  if (!iso) return Number.NaN;
  return easternTimeToUtc(iso, 0, 0) + msOfDay;
}

/** "2025-08-20T15:59:59.805" (Eastern wall clock) → epoch ms. */
export function etTimestampToUtc(ts: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(ts);
  if (!m) return Number.NaN;
  const [, y, mo, d, h, mi, s, frac] = m;
  const ms = Number((frac ?? "0").padEnd(3, "0"));
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms);
  // Guess the offset with EST, then use the offset actually in effect.
  const offset = easternOffsetMs(wall + 5 * 3_600_000);
  return wall - offset;
}

/** Contract identity of a stream message → canonical OCC; null if not an option. */
export function thetaContractToOcc(contract: ThetaStreamMessage["contract"]): string | null {
  if (!contract?.root || !contract.expiration || !contract.strike || !contract.right) return null;
  if (contract.security_type && contract.security_type !== "OPTION") return null;
  const iso = thetaDateToIso(contract.expiration);
  if (!iso) return null;
  const right = contract.right.toUpperCase().startsWith("P") ? "P" : "C";
  // Stream strikes are in 1/10th of a cent ($140 = 140000).
  return formatOcc(contract.root, iso, right as Right, contract.strike / 1000);
}

export function thetaExchange(code: number | undefined): string {
  if (code === undefined || code === null) return "?";
  return THETA_EXCHANGES[code] ?? String(code);
}

/** Pure mapper: one TRADE stream frame → RawOptionTrade (null = not a print). */
export function mapThetaTrade(
  msg: ThetaStreamMessage,
  nbbo: Nbbo | null = null,
): RawOptionTrade | null {
  if (msg.header?.type !== "TRADE" || !msg.trade) return null;
  const contract = thetaContractToOcc(msg.contract);
  if (!contract) return null;
  const t = msg.trade;
  if (t.price === undefined || t.size === undefined || t.date === undefined) return null;
  const ts = thetaTimestampToUtc(t.date, t.ms_of_day ?? 0);
  if (!Number.isFinite(ts)) return null;
  return {
    ts,
    contract,
    price: t.price,
    size: t.size,
    exchange: thetaExchange(t.exchange),
    conditions: t.condition === undefined ? [] : [String(t.condition)],
    nbbo,
    spot: null,
    oi: null,
  };
}

/** Pure mapper: one QUOTE stream frame → (contract, Nbbo) for the trade cache. */
export function mapThetaQuote(msg: ThetaStreamMessage): { contract: string; nbbo: Nbbo } | null {
  if (msg.header?.type !== "QUOTE" || !msg.quote) return null;
  const contract = thetaContractToOcc(msg.contract);
  if (!contract) return null;
  const q = msg.quote;
  if (q.bid === undefined || q.ask === undefined || q.date === undefined) return null;
  return {
    contract,
    nbbo: {
      bid: q.bid,
      ask: q.ask,
      bidSize: q.bid_size ?? 0,
      askSize: q.ask_size ?? 0,
      ts: thetaTimestampToUtc(q.date, q.ms_of_day ?? 0),
    },
  };
}

interface ThetaQuoteRow {
  symbol?: string;
  expiration?: string;
  strike?: number;
  right?: string;
  timestamp?: string;
  bid?: number;
  bid_size?: number;
  ask?: number;
  ask_size?: number;
}

interface ThetaOiRow {
  symbol?: string;
  expiration?: string;
  strike?: number;
  right?: string;
  open_interest?: number;
}

/*
  Historical (backfill) rows. The v3 history endpoints mirror the snapshot
  conventions used above — same base, ndjson format, ISO dates, expiration=*
  for chain-wide bulk — per the v3 REST docs and openapiv3.yaml cited at the
  top of this file.
  VERIFY: those mirrors are unreachable from this environment; paths and row
  field names below follow the v3 snapshot naming (symbol/expiration/strike/
  right + Eastern wall-clock `timestamp` strings) and are marked where the
  spelling is uncertain.
*/

/** One row of /v3/option/history/trade (bulk via expiration=*). */
export interface ThetaHistoryTradeRow {
  symbol?: string;
  expiration?: string;
  strike?: number;
  right?: string;
  /** Eastern wall-clock, e.g. "2026-08-20T09:30:00.123". */
  timestamp?: string;
  price?: number;
  size?: number;
  /** Exchange int, same table as the stream (THETA_EXCHANGES). */
  exchange?: number;
  /** One integer condition per print, same table as the stream. */
  condition?: number;
  sequence?: number;
}

/** One row of /v3/option/history/eod — end-of-day state per contract.
 *  VERIFY: bid/ask are the closing NBBO when the report carries them. */
export interface ThetaEodRow {
  symbol?: string;
  expiration?: string;
  strike?: number;
  right?: string;
  timestamp?: string;
  close?: number;
  volume?: number;
  count?: number;
  bid?: number;
  bid_size?: number;
  ask?: number;
  ask_size?: number;
}

/** Pure mapper: one historical trade row → RawOptionTrade (null = unusable). */
export function mapThetaHistoryTrade(row: ThetaHistoryTradeRow): RawOptionTrade | null {
  const contract = rowOcc(row);
  if (!contract) return null;
  if (row.price === undefined || row.size === undefined || !row.timestamp) return null;
  const ts = etTimestampToUtc(row.timestamp);
  if (!Number.isFinite(ts)) return null;
  return {
    ts,
    contract,
    price: row.price,
    size: row.size,
    exchange: thetaExchange(row.exchange),
    conditions: row.condition === undefined ? [] : [String(row.condition)],
    nbbo: null,
    spot: null,
    oi: null,
  };
}

interface ThetaGreeksRow {
  symbol?: string;
  expiration?: string;
  strike?: number;
  right?: string;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  implied_vol?: number;
  iv?: number;
}

function rowOcc(row: {
  symbol?: string;
  expiration?: string;
  strike?: number;
  right?: string;
}): string | null {
  if (!row.symbol || !row.expiration || row.strike === undefined || !row.right) return null;
  const right = row.right.toUpperCase().startsWith("P") ? "P" : "C";
  try {
    return formatOcc(row.symbol, row.expiration, right as Right, row.strike);
  } catch {
    return null;
  }
}

export class ThetadataFeed implements FeedAdapter {
  readonly id = "thetadata" as const;
  private readonly baseUrl: string;
  private readonly wsUrl: string;

  constructor(options: ThetadataOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:25503").replace(/\/+$/, "");
    this.wsUrl = options.wsUrl ?? "ws://127.0.0.1:25520/v1/events";
  }

  capabilities(): FeedCapabilities {
    // Greeks/IV ride on chain snapshots only for Professional-tier accounts;
    // the adapter degrades those fields to null on lower tiers.
    return { realtime: true, greeksProvided: true, nbbo: true, conditions: true };
  }

  normalizeCondition(code: string): NormalizedCondition {
    const n = Number(code);
    if (!Number.isInteger(n)) return "unknown";
    return THETA_CONDITIONS[n] ?? "unknown";
  }

  async *subscribeOptionTrades(
    filter: TradeFilter,
    signal?: AbortSignal,
  ): AsyncIterable<RawOptionTrade> {
    const wanted = new Set((filter.underlyings ?? []).map((u) => u.toUpperCase()));
    let attempt = 0;
    while (!signal?.aborted) {
      const queue = new AsyncQueue<RawOptionTrade>();
      const lastQuote = new Map<string, Nbbo>();
      const ws = new WebSocket(this.wsUrl);
      const onAbort = () => ws.close();
      signal?.addEventListener("abort", onAbort, { once: true });

      ws.on("open", () => {
        attempt = 0;
        // Full OPRA trade stream; the terminal offers per-contract or
        // full-universe subscriptions, so per-underlying filtering happens
        // client-side below. Envelope per the streaming docs.
        ws.send(
          JSON.stringify({
            msg_type: "STREAM_BULK",
            sec_type: "OPTION",
            req_type: "TRADE",
            add: true,
            id: 0,
          }),
        );
      });
      ws.on("message", (data) => {
        let msg: ThetaStreamMessage;
        try {
          msg = JSON.parse(data.toString()) as ThetaStreamMessage;
        } catch {
          return;
        }
        const type = msg.header?.type;
        if (type === "QUOTE") {
          const q = mapThetaQuote(msg);
          if (q) {
            // Bound the NBBO cache: on a full-universe day the map would
            // otherwise grow with every traded contract. FIFO eviction is
            // fine — a miss only means a REST NBBO lookup by the runner.
            if (lastQuote.size >= 200_000) {
              const oldest = lastQuote.keys().next().value;
              if (oldest !== undefined) lastQuote.delete(oldest);
            }
            lastQuote.delete(q.contract);
            lastQuote.set(q.contract, q.nbbo);
          }
          return;
        }
        if (type !== "TRADE") return; // STATUS keep-alives et al.
        const root = msg.contract?.root?.toUpperCase();
        if (wanted.size > 0 && (!root || !wanted.has(root))) return;
        const contract = thetaContractToOcc(msg.contract);
        const trade = mapThetaTrade(msg, contract ? (lastQuote.get(contract) ?? null) : null);
        if (trade) queue.push(trade);
      });
      ws.on("error", (err) => queue.fail(err));
      ws.on("close", () => queue.end());

      try {
        for await (const trade of queue) {
          yield trade;
          if (signal?.aborted) break;
        }
      } catch {
        // Socket error — fall through to the backoff/reconnect below.
      } finally {
        signal?.removeEventListener("abort", onAbort);
        ws.close();
      }
      if (signal?.aborted) return;
      attempt++;
      await sleep(backoffMs(attempt), signal);
    }
  }

  private async ndjson<T>(path: string, params: Record<string, string>): Promise<T[]> {
    const query = new URLSearchParams({ ...params, format: "ndjson" });
    const body = await fetchText(`${this.baseUrl}/v3${path}?${query}`, {
      headers: { Accept: "application/x-ndjson" },
    });
    return parseNdjson<T>(body);
  }

  async getNbbo(contract: string): Promise<Nbbo | null> {
    const parsed = parseOcc(contract);
    if (!parsed) return null;
    try {
      const rows = await this.ndjson<ThetaQuoteRow>("/option/snapshot/quote", {
        symbol: parsed.underlying,
        expiration: parsed.expiry,
        strike: parsed.strike.toFixed(3),
        right: parsed.right === "P" ? "put" : "call",
      });
      const row = rows[0];
      if (!row || row.bid === undefined || row.ask === undefined) return null;
      return {
        bid: row.bid,
        ask: row.ask,
        bidSize: row.bid_size ?? 0,
        askSize: row.ask_size ?? 0,
        ts: row.timestamp ? etTimestampToUtc(row.timestamp) : Date.now(),
      };
    } catch {
      return null;
    }
  }

  async getChainSnapshot(underlying: string): Promise<ChainSnapshot | null> {
    const symbol = underlying.toUpperCase();
    let quotes: ThetaQuoteRow[];
    try {
      quotes = await this.ndjson<ThetaQuoteRow>("/option/snapshot/quote", {
        symbol,
        expiration: "*",
      });
    } catch {
      return null; // no quote entitlement / unknown symbol / terminal down
    }
    if (quotes.length === 0) return null;

    const oiByOcc = new Map<string, number>();
    try {
      const rows = await this.ndjson<ThetaOiRow>("/option/snapshot/open_interest", {
        symbol,
        expiration: "*",
      });
      for (const row of rows) {
        const occ = rowOcc(row);
        if (occ && row.open_interest !== undefined) oiByOcc.set(occ, row.open_interest);
      }
    } catch {
      // OI degrades to null per contract.
    }

    const greeksByOcc = new Map<string, ThetaGreeksRow>();
    try {
      const rows = await this.ndjson<ThetaGreeksRow>("/option/snapshot/greeks/all", {
        symbol,
        expiration: "*",
      });
      for (const row of rows) {
        const occ = rowOcc(row);
        if (occ) greeksByOcc.set(occ, row);
      }
    } catch {
      // Greeks are Professional-tier; lower tiers degrade to null.
    }

    const ts = Date.now();
    const contracts: ChainContract[] = [];
    for (const row of quotes) {
      const occ = rowOcc(row);
      if (!occ || !row.expiration || row.strike === undefined || !row.right) continue;
      const greeks = greeksByOcc.get(occ);
      contracts.push({
        contract: occ,
        underlying: symbol,
        expiry: row.expiration,
        strike: row.strike,
        right: row.right.toUpperCase().startsWith("P") ? "P" : "C",
        oi: oiByOcc.get(occ) ?? null,
        // VERIFY: v3 greeks/all IV field name — implied_vol per the v3 docs
        // JSON guide; `iv` accepted as a fallback spelling.
        iv: greeks?.implied_vol ?? greeks?.iv ?? null,
        greeks: greeks
          ? {
              delta: greeks.delta ?? null,
              gamma: greeks.gamma ?? null,
              theta: greeks.theta ?? null,
              vega: greeks.vega ?? null,
            }
          : null,
        nbbo:
          row.bid !== undefined && row.ask !== undefined
            ? {
                bid: row.bid,
                ask: row.ask,
                bidSize: row.bid_size ?? 0,
                askSize: row.ask_size ?? 0,
                ts: row.timestamp ? etTimestampToUtc(row.timestamp) : ts,
              }
            : null,
      });
    }
    return { underlying: symbol, ts, spot: await this.getSpot(symbol), contracts };
  }

  async getSpot(underlying: string): Promise<number | null> {
    const symbol = underlying.toUpperCase();
    try {
      const rows = await this.ndjson<{ price?: number }>("/stock/snapshot/trade", { symbol });
      const price = rows[0]?.price;
      if (price !== undefined && Number.isFinite(price)) return price;
    } catch {
      // fall through to the quote mid
    }
    try {
      const rows = await this.ndjson<{ bid?: number; ask?: number }>("/stock/snapshot/quote", {
        symbol,
      });
      const row = rows[0];
      if (row?.bid !== undefined && row.ask !== undefined && row.bid > 0 && row.ask > 0) {
        return (row.bid + row.ask) / 2;
      }
    } catch {
      // no stock entitlement — spot degrades to null
    }
    return null;
  }

  /**
   * Historical option trades for one session, chain-wide bulk. The terminal
   * serves the whole day as one ndjson body (it is the local cache layer, so
   * buffering here is a memory cost, not a rate-limit cost). Rows arrive
   * grouped per contract, so they are re-sorted into time order before
   * yielding. Entitlement: historical trades need a Standard+ subscription.
   * VERIFY: v3 path/params — /option/history/trade with symbol, expiration=*
   * (bulk), start_date/end_date as ISO dates, mirroring the snapshot calls.
   */
  async *getHistoricalOptionTrades(
    underlying: string,
    dateIso: string,
    signal?: AbortSignal,
  ): AsyncIterable<RawOptionTrade> {
    const rows = await this.ndjson<ThetaHistoryTradeRow>("/option/history/trade", {
      symbol: underlying.toUpperCase(),
      expiration: "*",
      start_date: dateIso,
      end_date: dateIso,
    });
    const trades: RawOptionTrade[] = [];
    for (const row of rows) {
      const trade = mapThetaHistoryTrade(row);
      if (trade) trades.push(trade);
    }
    trades.sort((a, b) => a.ts - b.ts);
    for (const trade of trades) {
      if (signal?.aborted) return;
      yield trade;
    }
  }

  /**
   * End-of-session chain: EOD report (closing NBBO + volume) joined with the
   * open-interest report at that date, chain-wide bulk. IV is left null —
   * greeks history is a Professional-tier surface and its v3 path could not
   * be verified, so it is not guessed at. Spot close comes from the stock
   * EOD report and degrades to null without a stock entitlement.
   * VERIFY: v3 paths — /option/history/eod, /option/history/open_interest,
   * /stock/history/eod, all with start_date/end_date ISO params.
   */
  async getHistoricalChain(underlying: string, dateIso: string): Promise<ChainSnapshot | null> {
    const symbol = underlying.toUpperCase();
    const dateParams = { start_date: dateIso, end_date: dateIso };
    let eodRows: ThetaEodRow[];
    try {
      eodRows = await this.ndjson<ThetaEodRow>("/option/history/eod", {
        symbol,
        expiration: "*",
        ...dateParams,
      });
    } catch {
      return null; // no historical entitlement / unknown symbol / terminal down
    }
    if (eodRows.length === 0) return null;

    const oiByOcc = new Map<string, number>();
    try {
      const rows = await this.ndjson<ThetaOiRow>("/option/history/open_interest", {
        symbol,
        expiration: "*",
        ...dateParams,
      });
      for (const row of rows) {
        const occ = rowOcc(row);
        if (occ && row.open_interest !== undefined) oiByOcc.set(occ, row.open_interest);
      }
    } catch {
      // OI degrades to null per contract.
    }

    let spot: number | null = null;
    try {
      const rows = await this.ndjson<{ close?: number }>("/stock/history/eod", {
        symbol,
        ...dateParams,
      });
      const close = rows[0]?.close;
      if (close !== undefined && Number.isFinite(close)) spot = close;
    } catch {
      // no stock entitlement — spot close degrades to null
    }

    const closeTs = easternTimeToUtc(dateIso, 16);
    const contracts: ChainContract[] = [];
    for (const row of eodRows) {
      const occ = rowOcc(row);
      if (!occ || !row.expiration || row.strike === undefined || !row.right) continue;
      contracts.push({
        contract: occ,
        underlying: symbol,
        expiry: row.expiration,
        strike: row.strike,
        right: row.right.toUpperCase().startsWith("P") ? "P" : "C",
        oi: oiByOcc.get(occ) ?? null,
        volume: row.volume ?? null,
        iv: null,
        greeks: null,
        nbbo:
          row.bid !== undefined && row.ask !== undefined
            ? {
                bid: row.bid,
                ask: row.ask,
                bidSize: row.bid_size ?? 0,
                askSize: row.ask_size ?? 0,
                ts: closeTs,
              }
            : null,
      });
    }
    if (contracts.length === 0) return null;
    return { underlying: symbol, ts: closeTs, spot, contracts };
  }
}
