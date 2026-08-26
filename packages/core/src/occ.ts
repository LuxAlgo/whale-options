/*
  OCC option symbology. Canonical form here is the unpadded OCC symbol
  (ROOT + YYMMDD + C/P + strike×1000 as 8 digits): NVDA260918C00120000.
  Vendors disagree on dressing — OSI pads the root to 6 chars, Polygon-style
  feeds prefix "O:", some send dots — so parsing accepts all of those and
  formatting always emits the canonical form used for ids and storage.
*/
import type { OptionContract, Right } from "./types.js";

const OCC_RE = /^([A-Z][A-Z0-9./]{0,9})\s*(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

/** Parse any common OCC/OSI variant. Returns null when it doesn't parse. */
export function parseOcc(symbol: string): OptionContract | null {
  let s = symbol.trim().toUpperCase();
  if (s.startsWith("O:")) s = s.slice(2);
  if (s.startsWith(".")) s = s.slice(1);
  const m = OCC_RE.exec(s.replace(/\s+/g, ""));
  if (!m) return null;
  const [, root, yy, mm, dd, right, strikeRaw] = m;
  if (!root || !yy || !mm || !dd || !right || !strikeRaw) return null;
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const strike = Number(strikeRaw) / 1000;
  if (!Number.isFinite(strike) || strike <= 0) return null;
  const expiry = `20${yy}-${mm}-${dd}`;
  return {
    occ: formatOcc(root, expiry, right as Right, strike),
    underlying: root,
    expiry,
    strike,
    right: right as Right,
  };
}

/** Canonical unpadded OCC symbol. */
export function formatOcc(
  underlying: string,
  expiry: string,
  right: Right,
  strike: number,
): string {
  const [y, m, d] = expiry.split("-");
  if (!y || !m || !d) throw new Error(`invalid expiry: ${expiry}`);
  const thousandths = Math.round(strike * 1000);
  return `${underlying.toUpperCase()}${y.slice(2)}${m}${d}${right}${String(thousandths).padStart(8, "0")}`;
}

/** OSI 21-char form (root space-padded to 6) for vendors that require it. */
export function formatOsi(
  underlying: string,
  expiry: string,
  right: Right,
  strike: number,
): string {
  const canonical = formatOcc(underlying, expiry, right, strike);
  const root = underlying.toUpperCase();
  return root.padEnd(6, " ") + canonical.slice(root.length);
}
