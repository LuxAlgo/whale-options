/*
  Deterministic ids. Event ids are content hashes of their legs, so the same
  tape + config always yields the same ids — the property that makes
  `whale replay` and the alert→event audit trail trustworthy.
*/
import { createHash } from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** JSON.stringify with sorted object keys, for stable hashing/goldens. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function eventId(parts: {
  kind: string;
  side: string;
  contract: string;
  firstSeq: number;
  legSummaries: Array<{ ts: number; price: number; size: number; exchange: string }>;
}): string {
  const payload = stableStringify(parts);
  return `ev_${sha256Hex(payload).slice(0, 16)}`;
}
