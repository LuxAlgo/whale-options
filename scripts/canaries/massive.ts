/*
  Massive canary — daily CI smoke against the cheapest real surface: one
  REST chain-snapshot page (works on delayed/starter options keys, no
  market-hours dependency). It exercises the chain mapper, the exchange-id
  mapping and the condition table against whatever last_trade rows the
  vendor returns. Output contract: one line starting with PASS/SKIP/FAIL;
  non-zero exit only on FAIL.
*/
import {
  MassiveFeed,
  mapMassiveChainContract,
  massiveExchange,
} from "../../packages/core/src/feeds/massive.js";

const FEED = "massive";

interface SnapshotRow {
  details?: { ticker?: string };
  last_trade?: { conditions?: number[]; exchange?: number; price?: number; size?: number };
}

async function main(): Promise<void> {
  const apiKey = process.env.MASSIVE_API_KEY ?? process.env.POLYGON_API_KEY;
  if (!apiKey) {
    console.log(`SKIP ${FEED}: MASSIVE_API_KEY not set (POLYGON_API_KEY also accepted)`);
    return;
  }
  const restBase = (process.env.MASSIVE_REST_BASE ?? "https://api.massive.com").replace(/\/+$/, "");
  const feed = new MassiveFeed({ apiKey, restBase });

  const res = await fetch(`${restBase}/v3/snapshot/options/SPY?limit=50&apiKey=${apiKey}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`auth rejected (HTTP ${res.status}) — check the API key`);
  }
  if (!res.ok) throw new Error(`chain snapshot -> HTTP ${res.status}`);
  const body = (await res.json()) as { status?: string; results?: SnapshotRow[] };
  const rows = body.results ?? [];
  if (rows.length === 0) throw new Error(`no contracts returned (status=${body.status})`);

  let mapped = 0;
  let tradesSeen = 0;
  let conditionsSeen = 0;
  let unknownConditions = 0;
  for (const row of rows) {
    if (mapMassiveChainContract(row) !== null) mapped++;
    const lastTrade = row.last_trade;
    if (!lastTrade) continue;
    tradesSeen++;
    massiveExchange(lastTrade.exchange); // must not throw
    for (const code of lastTrade.conditions ?? []) {
      conditionsSeen++;
      if (feed.normalizeCondition(String(code)) === "unknown") unknownConditions++;
    }
  }
  if (mapped === 0) throw new Error("chain mapper produced no contracts from live rows");
  console.log(
    `PASS ${FEED}: ${mapped}/${rows.length} contracts mapped, ${tradesSeen} last trades, ${conditionsSeen} condition codes (${unknownConditions} unmapped)`,
  );
}

main().catch((err) => {
  console.log(`FAIL ${FEED}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
