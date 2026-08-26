/*
  ThetaData canary — a daily CI smoke that answers one question: does the
  adapter still speak the Theta Terminal v3 dialect? It needs a locally
  running terminal (auth lives there, so there is no key env); when the
  terminal is not reachable the canary SKIPs with exit 0 so CI lanes without
  a terminal stay green. Output contract: one line starting with
  PASS/SKIP/FAIL; non-zero exit only on FAIL.
*/

import { etTimestampToUtc, ThetadataFeed } from "../../packages/core/src/feeds/thetadata.js";
import { formatOcc, parseOcc } from "../../packages/core/src/occ.js";

const FEED = "thetadata";
const baseUrl = (process.env.THETADATA_BASE_URL ?? "http://127.0.0.1:25503").replace(/\/+$/, "");

interface TradeRow {
  symbol?: string;
  expiration?: string;
  strike?: number;
  right?: string;
  timestamp?: string;
  condition?: number;
  size?: number;
  exchange?: number;
  price?: number;
}

async function ndjson(path: string, params: Record<string, string>): Promise<string[]> {
  const query = new URLSearchParams({ ...params, format: "ndjson" });
  const res = await fetch(`${baseUrl}/v3${path}?${query}`, {
    headers: { Accept: "application/x-ndjson" },
  });
  if (res.status === 471 || res.status === 472) {
    // 471 = subscription tier lacks this endpoint, 472 = no data cached
    // (e.g. market closed all day) — neither is an adapter defect.
    return [];
  }
  if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
  return (await res.text()).split("\n").filter((line) => line.trim().length > 0);
}

async function main(): Promise<void> {
  // Reachability probe doubles as the "credentials" gate for this feed.
  try {
    await fetch(`${baseUrl}/v3/option/snapshot/quote?symbol=SPY&strike_range=1&format=ndjson`, {
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    console.log(`SKIP ${FEED}: Theta Terminal not reachable at ${baseUrl} (THETADATA_BASE_URL)`);
    return;
  }

  const feed = new ThetadataFeed({ baseUrl });
  let quoteRows = 0;
  let tradeRows = 0;
  let mapped = 0;
  let unknownConditions = 0;

  const quotes = await ndjson("/option/snapshot/quote", {
    symbol: "SPY",
    expiration: "*",
    strike_range: "2",
  });
  quoteRows = quotes.length;

  // Last-trade snapshot exercises the OCC builder, the ET timestamp
  // conversion and the condition table against live vendor rows.
  const trades = await ndjson("/option/snapshot/trade", {
    symbol: "SPY",
    expiration: "*",
    strike_range: "2",
  });
  for (const line of trades) {
    tradeRows++;
    const row = JSON.parse(line) as TradeRow;
    if (!row.symbol || !row.expiration || row.strike === undefined || !row.right) continue;
    const occ = formatOcc(
      row.symbol,
      row.expiration,
      row.right.toUpperCase().startsWith("P") ? "P" : "C",
      row.strike,
    );
    if (!parseOcc(occ)) throw new Error(`unparseable OCC from row: ${occ}`);
    if (row.timestamp && !Number.isFinite(etTimestampToUtc(row.timestamp))) {
      throw new Error(`bad timestamp: ${row.timestamp}`);
    }
    if (row.condition !== undefined) {
      const normalized = feed.normalizeCondition(String(row.condition));
      if (normalized === "unknown") unknownConditions++;
    }
    mapped++;
  }

  if (quoteRows === 0 && tradeRows === 0) {
    console.log(
      `SKIP ${FEED}: terminal reachable at ${baseUrl} but returned no snapshot rows (tier or market hours)`,
    );
    return;
  }
  console.log(
    `PASS ${FEED}: ${quoteRows} quote rows, ${mapped}/${tradeRows} trade rows mapped, ${unknownConditions} unmapped conditions`,
  );
}

main().catch((err) => {
  console.log(`FAIL ${FEED}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
