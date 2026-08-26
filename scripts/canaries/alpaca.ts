/*
  Alpaca canary — daily CI smoke on the free tier: (1) the options
  trade-conditions meta endpoint must be fully covered by the adapter's
  condition table (the drift alarm — a new OPRA letter fails the canary),
  (2) one chain-snapshot page must map, and (3) the indicative stream must
  connect and authenticate through the adapter's own subscribe loop; trades
  received while the market prints go through the mapper. Output contract:
  one line starting with PASS/SKIP/FAIL; non-zero exit only on FAIL.
*/
import { AlpacaFeed, mapAlpacaChainContract } from "../../packages/core/src/feeds/alpaca.js";
import { FeedAuthError } from "../../packages/core/src/feeds/feed-util.js";

const FEED = "alpaca";
const DATA_BASE = "https://data.alpaca.markets";

/** Ride the adapter's real subscribe loop for a few seconds. A bad key
 *  throws FeedAuthError; a quiet (closed) market just times out at zero. */
async function streamProbe(feed: AlpacaFeed): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let trades = 0;
  try {
    for await (const trade of feed.subscribeOptionTrades({}, controller.signal)) {
      if (trade.price > 0 && trade.size > 0) trades++;
      if (trades >= 5) controller.abort();
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return trades;
}

async function main(): Promise<void> {
  const keyId = process.env.ALPACA_API_KEY_ID;
  const secretKey = process.env.ALPACA_API_SECRET_KEY;
  if (!keyId || !secretKey) {
    console.log(`SKIP ${FEED}: ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY not set`);
    return;
  }
  const feed = new AlpacaFeed({ keyId, secretKey, stream: "indicative" });
  const headers = {
    "APCA-API-KEY-ID": keyId,
    "APCA-API-SECRET-KEY": secretKey,
    Accept: "application/json",
  };

  // 1) Condition-table coverage against the vendor's own conditions map.
  const condRes = await fetch(`${DATA_BASE}/v1beta1/options/meta/conditions/trade`, { headers });
  if (condRes.status === 401 || condRes.status === 403) {
    throw new Error(`auth rejected (HTTP ${condRes.status}) — check the API keys`);
  }
  if (!condRes.ok) throw new Error(`meta/conditions/trade -> HTTP ${condRes.status}`);
  const conditions = (await condRes.json()) as Record<string, string>;
  const unmapped = Object.keys(conditions).filter(
    (code) => feed.normalizeCondition(code) === "unknown",
  );
  if (unmapped.length > 0) {
    throw new Error(`vendor lists unmapped condition letters: ${unmapped.join(", ")}`);
  }

  // 2) One chain-snapshot page maps into ChainContracts.
  const snapRes = await fetch(
    `${DATA_BASE}/v1beta1/options/snapshots/SPY?feed=indicative&limit=50`,
    { headers },
  );
  if (!snapRes.ok) throw new Error(`options/snapshots/SPY -> HTTP ${snapRes.status}`);
  const snapBody = (await snapRes.json()) as { snapshots?: Record<string, object> };
  const entries = Object.entries(snapBody.snapshots ?? {});
  const mappedContracts = entries.filter(
    ([occ, snap]) => mapAlpacaChainContract(occ, snap) !== null,
  ).length;
  if (entries.length === 0 || mappedContracts === 0) {
    throw new Error(`chain snapshot returned ${entries.length} rows, mapped ${mappedContracts}`);
  }

  // 3) Indicative stream handshake via the adapter itself.
  let trades = 0;
  try {
    trades = await streamProbe(feed);
  } catch (err) {
    if (err instanceof FeedAuthError) throw err;
    throw new Error(`stream probe failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(
    `PASS ${FEED}: ${Object.keys(conditions).length} vendor conditions all mapped, ${mappedContracts}/${entries.length} snapshot contracts mapped, stream ok (${trades} trades seen)`,
  );
  process.exit(0); // a lingering socket handle must not hold the process open
}

main().catch((err) => {
  console.log(`FAIL ${FEED}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
