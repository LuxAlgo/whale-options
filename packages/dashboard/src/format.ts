/*
  Formatting helpers, mirroring the CLI renderer where a convention already
  exists there (compact money, ET clock times) so the dashboard reads as the
  terminal's visual sibling. The browser has a real tz database, so ET times
  come from Intl with America/New_York — the engine's no-Intl rule is about
  deterministic classification, not display.
*/

const ET_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const ET_DATE_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** "14:23:07" in ET. */
export function etTime(ts: number): string {
  return ET_TIME.format(ts);
}

/** "14:23:07.123" in ET — leg tables care about the milliseconds. */
export function etTimeMs(ts: number): string {
  const ms = Math.floor(ts % 1000)
    .toString()
    .padStart(3, "0");
  return `${ET_TIME.format(ts)}.${ms}`;
}

/** "2026-08-24 14:23:07" in ET. */
export function etDateTime(ts: number): string {
  const parts = ET_DATE_TIME.formatToParts(ts);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/** Compact premium dollars, same breakpoints as the CLI: $103K / $1.86M. */
export function money(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return `$${Math.round(v)}`;
}

/** Signed compact dollars for GEX values (can be negative and billions). */
export function signedMoney(v: number): string {
  const sign = v < 0 ? "-" : "+";
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}K`;
  return `${sign}$${Math.round(abs)}`;
}

export function int(v: number): string {
  return v.toLocaleString("en-US");
}

/** Raw score inputs: integers get thousands separators, floats stay short. */
export function rawValue(v: number | string | null): string {
  if (v === null) return "∅";
  if (typeof v === "string") return v;
  if (Number.isInteger(v)) return v.toLocaleString("en-US");
  return String(Number(v.toFixed(3)));
}

/** Strike as the terminal prints it: $190 or $187.5. */
export function strikeText(strike: number): string {
  return `$${Number.isInteger(strike) ? strike : strike.toFixed(2).replace(/0$/, "")}`;
}
