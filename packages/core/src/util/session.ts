/*
  US-equity session math without Intl. Session dates and DTE must be
  deterministic across machines and ICU builds, so US Eastern offsets are
  computed directly from the post-2007 DST rules: DST begins the second
  Sunday of March at 02:00 local and ends the first Sunday of November.
*/

const HOUR = 3_600_000;
const DAY = 86_400_000;

function nthSundayUtc(year: number, monthIndex: number, nth: number): number {
  const first = Date.UTC(year, monthIndex, 1);
  const firstDow = new Date(first).getUTCDay();
  const offsetDays = (7 - firstDow) % 7;
  return first + (offsetDays + (nth - 1) * 7) * DAY;
}

/** DST window for a year in UTC ms: [start, end). 2:00 EST = 07:00 UTC; 2:00 EDT = 06:00 UTC. */
function dstWindowUtc(year: number): { start: number; end: number } {
  const start = nthSundayUtc(year, 2, 2) + 7 * HOUR;
  const end = nthSundayUtc(year, 10, 1) + 6 * HOUR;
  return { start, end };
}

/** UTC offset of America/New_York at the given instant, in ms (negative). */
export function easternOffsetMs(tsMs: number): number {
  const year = new Date(tsMs).getUTCFullYear();
  const { start, end } = dstWindowUtc(year);
  const isDst = tsMs >= start && tsMs < end;
  return isDst ? -4 * HOUR : -5 * HOUR;
}

/** The America/New_York calendar date of an instant, as "YYYY-MM-DD". */
export function sessionDateOf(tsMs: number): string {
  const local = new Date(tsMs + easternOffsetMs(tsMs));
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  const d = String(local.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Epoch ms of a given Eastern wall-clock time on an ISO date. */
export function easternTimeToUtc(isoDate: string, hour: number, minute = 0): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) throw new Error(`invalid date: ${isoDate}`);
  // Guess with EST, then correct using the offset actually in effect.
  const guess = Date.UTC(y, m - 1, d, hour + 5, minute);
  const offset = easternOffsetMs(guess);
  return Date.UTC(y, m - 1, d, hour, minute) - offset;
}

/**
 * Days to expiry (fractional), measured to the 16:00 Eastern close on the
 * expiry date. Floors at 0 for same-day prints after the close.
 */
export function dteOf(tsMs: number, expiry: string): number {
  const expiryClose = easternTimeToUtc(expiry, 16);
  return Math.max(0, (expiryClose - tsMs) / DAY);
}

/** Round to a fixed number of decimals — keeps golden files stable. */
export function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
