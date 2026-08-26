/*
  FINRA daily short-sale volume — end-of-day context, never real-time.

  FINRA publishes daily short-sale volume files for off-exchange trades
  reported to FINRA facilities. This module downloads the consolidated
  (CNMS) file for a session, filters it to the user's universe, and caches
  it in the flight recorder. The data is fetched from FINRA directly by
  each user's own installation and never redistributed.

  What this data is NOT — and every report from this module says so:
  it is not real-time dark-pool data (published end-of-day only), and short
  volume is not short interest (market-maker hedging and liquidity provision
  print short structurally, so the ratio runs high for mechanical reasons).
*/

import type { FlightRecorder, ShortVolumeRow } from "../store/types.js";
import { sessionDateOf } from "../util/session.js";

// VERIFY: documented FINRA CDN location for the consolidated (CNMS) daily
// short-sale volume files, e.g. CNMSshvol20260824.txt. Live verification was
// egress-blocked in this environment; confirm the URL pattern still holds.
export const FINRA_SHORT_VOLUME_BASE_URL = "https://cdn.finra.org/equity/regsho/daily";

/** The `source` tag stored on every row this module writes. */
export const SHORT_VOLUME_SOURCE = "finra-cnms";

/**
 * The honesty note attached to every report. Relay it with the numbers —
 * without it the ratio invites exactly the misreadings it does not support.
 */
export const SHORT_VOLUME_NOTE =
  "FINRA consolidated short-sale volume: off-exchange trades reported to FINRA facilities, " +
  "published end-of-day. A high short ratio is NOT a real-time dark-pool signal, and short " +
  "volume is NOT short interest; market-maker hedging and liquidity provision print short " +
  "structurally, so elevated ratios are the mechanical norm, not evidence of directional bets. " +
  "End-of-day context only.";

/** Thrown when FINRA has no file for a date (weekend, holiday, not yet
 *  published). Callers treat it as "skip this date", not as a failure. */
export class ShortVolumeFileMissingError extends Error {
  readonly dateIso: string;

  constructor(dateIso: string, detail?: string) {
    super(`no FINRA short-volume file for ${dateIso}${detail ? ` (${detail})` : ""}`);
    this.dateIso = dateIso;
  }
}

/** URL of the consolidated daily file for an ISO session date. */
export function shortVolumeFileUrl(dateIso: string, baseUrl = FINRA_SHORT_VOLUME_BASE_URL): string {
  return `${baseUrl.replace(/\/$/, "")}/CNMSshvol${dateIso.replaceAll("-", "")}.txt`;
}

// VERIFY: documented column set of the pipe-delimited CNMS file.
const DEFAULT_COLUMNS = [
  "date",
  "symbol",
  "shortvolume",
  "shortexemptvolume",
  "totalvolume",
  "market",
] as const;

/** "20260824" (or an already-ISO date) → "2026-08-24"; null when neither. */
function toIsoDate(field: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(field)) return field;
  if (/^\d{8}$/.test(field))
    return `${field.slice(0, 4)}-${field.slice(4, 6)}-${field.slice(6, 8)}`;
  return null;
}

function toVolume(field: string): number | null {
  if (!/^\d+$/.test(field)) return null;
  return Number(field);
}

/**
 * Parse one FINRA daily short-sale volume file (pipe-delimited:
 * Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market).
 *
 * Header-tolerant: when the first line is a header its column order wins,
 * otherwise the documented order is assumed. Malformed lines and the trailing
 * footer/record-count line (when present) are skipped, never thrown on.
 */
export function parseShortVolumeFile(text: string, source: string): ShortVolumeRow[] {
  const lines = text.split(/\r?\n/);
  let columns: readonly string[] = DEFAULT_COLUMNS;
  let start = 0;

  const first = lines[0]?.trim();
  if (first && /[a-z]/i.test(first.split("|")[0] ?? "")) {
    // A header names its columns; map them so a reordered file still parses.
    columns = first.split("|").map((c) => c.trim().toLowerCase().replaceAll(" ", ""));
    start = 1;
  }
  const idx = (name: (typeof DEFAULT_COLUMNS)[number]) => columns.indexOf(name);
  const [iDate, iSymbol, iShort, iExempt, iTotal] = [
    idx("date"),
    idx("symbol"),
    idx("shortvolume"),
    idx("shortexemptvolume"),
    idx("totalvolume"),
  ];
  if (iDate < 0 || iSymbol < 0 || iShort < 0 || iExempt < 0 || iTotal < 0) return [];

  const rows: ShortVolumeRow[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const fields = line.split("|");
    // Too few fields covers the footer/record-count trailer some files carry.
    if (fields.length < columns.length) continue;
    const sessionDate = toIsoDate(fields[iDate]?.trim() ?? "");
    const symbol = fields[iSymbol]?.trim().toUpperCase() ?? "";
    const shortVolume = toVolume(fields[iShort]?.trim() ?? "");
    const shortExemptVolume = toVolume(fields[iExempt]?.trim() ?? "");
    const totalVolume = toVolume(fields[iTotal]?.trim() ?? "");
    if (
      sessionDate === null ||
      !symbol ||
      shortVolume === null ||
      shortExemptVolume === null ||
      totalVolume === null
    ) {
      continue; // malformed line — skip, never throw
    }
    rows.push({ symbol, sessionDate, shortVolume, shortExemptVolume, totalVolume, source });
  }
  return rows;
}

export interface FetchShortVolumeOptions {
  baseUrl?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Download and parse one session's consolidated file. The file covers the
 * whole market — callers filter to their universe before storing. A 404
 * (weekend, holiday, not yet published) throws ShortVolumeFileMissingError
 * so callers can treat it as a skip.
 */
export async function fetchShortVolumeDay(
  dateIso: string,
  options: FetchShortVolumeOptions = {},
): Promise<ShortVolumeRow[]> {
  const url = shortVolumeFileUrl(dateIso, options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(url);
  if (res.status === 404) throw new ShortVolumeFileMissingError(dateIso, "HTTP 404");
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`GET ${url} -> HTTP ${res.status}${body ? `: ${body}` : ""}`);
  }
  return parseShortVolumeFile(await res.text(), SHORT_VOLUME_SOURCE);
}

/** The `count` most recent weekdays ending at `todayIso` (inclusive when a
 *  weekday), oldest first. Holidays are not modeled — they 404 and get
 *  skipped at fetch time. */
export function recentWeekdays(todayIso: string, count: number): string[] {
  const [y, m, d] = todayIso.split("-").map(Number);
  if (!y || !m || !d) throw new Error(`invalid date: ${todayIso}`);
  const dates: string[] = [];
  let cursor = Date.UTC(y, m - 1, d);
  while (dates.length < count) {
    const day = new Date(cursor).getUTCDay();
    if (day !== 0 && day !== 6) {
      dates.push(new Date(cursor).toISOString().slice(0, 10));
    }
    cursor -= 86_400_000;
  }
  return dates.reverse();
}

export interface SyncShortVolumeOptions {
  store: FlightRecorder;
  /** Symbols to keep. The FINRA file covers the whole market; only these are
   *  stored, so the flight recorder stays scoped to the user's universe. */
  symbols: string[];
  /** How many weekdays back to cover, ending today. */
  days: number;
  /** ISO session date to anchor the walk-back; defaults to today (Eastern). */
  today?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export interface SyncShortVolumeResult {
  daysFetched: number;
  /** Dates not fetched: already fully cached, or FINRA had no file (weekend
   *  walk-back never lands here — weekends are never attempted). */
  daysSkipped: string[];
  rowsStored: number;
}

/**
 * Walk back N weekdays and fill the flight recorder's short-volume cache.
 * A date already cached for every requested symbol is skipped without a
 * network call, so re-running the sync is cheap and idempotent.
 */
export async function syncShortVolume(
  options: SyncShortVolumeOptions,
): Promise<SyncShortVolumeResult> {
  const { store, days } = options;
  const symbols = [...new Set(options.symbols.map((s) => s.trim().toUpperCase()))].filter(Boolean);
  if (symbols.length === 0 || days <= 0) return { daysFetched: 0, daysSkipped: [], rowsStored: 0 };

  const today = options.today ?? sessionDateOf(Date.now());
  const dates = recentWeekdays(today, days);
  const wanted = new Set(symbols);

  // One cache probe per symbol up front, instead of one per (symbol, date).
  const cachedDates = new Map<string, Set<string>>(
    symbols.map((s) => [s, new Set(store.getShortVolume(s, days).map((r) => r.sessionDate))]),
  );

  let daysFetched = 0;
  let rowsStored = 0;
  const daysSkipped: string[] = [];

  for (const date of dates) {
    if (symbols.every((s) => cachedDates.get(s)?.has(date))) {
      daysSkipped.push(date);
      continue;
    }
    let fileRows: ShortVolumeRow[];
    try {
      fileRows = await fetchShortVolumeDay(date, {
        baseUrl: options.baseUrl,
        fetchImpl: options.fetchImpl,
      });
    } catch (err) {
      if (err instanceof ShortVolumeFileMissingError) {
        daysSkipped.push(date);
        continue;
      }
      throw err;
    }
    daysFetched++;
    const kept = fileRows.filter((r) => wanted.has(r.symbol) && r.sessionDate === date);
    if (kept.length > 0) {
      store.upsertShortVolume(kept);
      rowsStored += kept.length;
    }
  }
  return { daysFetched, daysSkipped, rowsStored };
}

export interface ShortVolumeReportDay {
  sessionDate: string;
  shortVolume: number;
  shortExemptVolume: number;
  totalVolume: number;
  /** shortVolume / totalVolume; null when the day's total volume is zero. */
  shortRatio: number | null;
}

export interface ShortVolumeReport {
  symbol: string;
  days: ShortVolumeReportDay[];
  /** Mean of the defined daily ratios; null when no day has one. */
  avgShortRatio: number | null;
  /** Always present: what this data is and is not. Relay it with the numbers. */
  note: string;
}

/** Read the cached short-volume history for a symbol — no network. */
export function shortVolumeReport(
  store: FlightRecorder,
  symbol: string,
  days = 20,
): ShortVolumeReport {
  const rows = store.getShortVolume(symbol.toUpperCase(), days);
  const reportDays = rows.map((r) => ({
    sessionDate: r.sessionDate,
    shortVolume: r.shortVolume,
    shortExemptVolume: r.shortExemptVolume,
    totalVolume: r.totalVolume,
    shortRatio: r.totalVolume > 0 ? r.shortVolume / r.totalVolume : null,
  }));
  const ratios = reportDays.map((d) => d.shortRatio).filter((r): r is number => r !== null);
  const avgShortRatio =
    ratios.length > 0 ? ratios.reduce((sum, r) => sum + r, 0) / ratios.length : null;
  return {
    symbol: symbol.toUpperCase(),
    days: reportDays,
    avgShortRatio,
    note: SHORT_VOLUME_NOTE,
  };
}
