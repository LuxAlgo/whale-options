/*
  Tradier canary — daily CI smoke on the REST surface (quotes, expirations,
  one chain page), which works against production or sandbox tokens and
  outside market hours; streaming needs a production brokerage session and
  stays out of the canary. Exercises the Bearer auth, the object-or-array-
  or-null list() normalization, the chain mapper with ORATS greeks, and the
  timesale mapper + condition table on an invented, vendor-shaped event.
  Output contract: one line starting with PASS/SKIP/FAIL; non-zero exit only
  on FAIL. Point TRADIER_API_BASE at https://sandbox.tradier.com/v1 to run
  against the sandbox.
*/
import {
  list,
  mapTradierChainOption,
  mapTradierTimesale,
  type TradierChainOption,
  TradierFeed,
} from "../../packages/core/src/feeds/tradier.js";

const FEED = "tradier";

async function main(): Promise<void> {
  const accessToken = process.env.TRADIER_ACCESS_TOKEN;
  if (!accessToken) {
    console.log(`SKIP ${FEED}: TRADIER_ACCESS_TOKEN not set`);
    return;
  }
  const apiBase = (process.env.TRADIER_API_BASE ?? "https://api.tradier.com/v1").replace(
    /\/+$/,
    "",
  );
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
  const feed = new TradierFeed({ accessToken, apiBase });

  // 1) Quotes endpoint (the cheapest real surface) through the adapter.
  const spot = await feed.getSpot("SPY");
  if (spot === null) throw new Error("quotes endpoint returned no usable SPY quote");

  // 2) Expirations + one chain page, exercising list() on live shapes.
  const expRes = await fetch(
    `${apiBase}/markets/options/expirations?symbol=SPY&includeAllRoots=true&strikes=false`,
    { headers },
  );
  if (expRes.status === 401) throw new Error("auth rejected (HTTP 401) — check the access token");
  if (!expRes.ok) throw new Error(`options/expirations -> HTTP ${expRes.status}`);
  const expBody = (await expRes.json()) as {
    expirations?: { date?: string | string[] | null } | null | "null";
  };
  const expirations = expBody.expirations === "null" ? [] : list(expBody.expirations?.date);
  if (expirations.length === 0) throw new Error("no SPY expirations returned");

  const chainRes = await fetch(
    `${apiBase}/markets/options/chains?symbol=SPY&expiration=${expirations[0]}&greeks=true`,
    { headers },
  );
  if (!chainRes.ok) throw new Error(`options/chains -> HTTP ${chainRes.status}`);
  const chainBody = (await chainRes.json()) as {
    options?: { option?: TradierChainOption | TradierChainOption[] | null | "null" } | null;
  };
  const rows = list(chainBody.options?.option);
  if (rows.length === 0) throw new Error(`chain for ${expirations[0]} came back empty`);
  const mapped = rows.map(mapTradierChainOption).filter((c) => c !== null);
  if (mapped.length === 0) throw new Error("chain mapper produced no contracts from live rows");
  const withGreeks = mapped.filter((c) => c?.greeks).length;

  // 3) Timesale mapper + condition table on an invented, vendor-shaped
  //    event (never recorded market data).
  const sample = mapTradierTimesale({
    type: "timesale",
    symbol: mapped[0]?.contract ?? "SPY270115C00500000",
    exch: "Q",
    bid: "1.00",
    ask: "1.10",
    last: "1.10",
    size: "5",
    date: String(Date.now()),
    seq: 1,
    flag: "",
    cancel: false,
    correction: false,
    session: "normal",
  });
  if (!sample || sample.nbbo === null) throw new Error("timesale mapper failed on shaped sample");
  if (feed.normalizeCondition("cancel") !== "cancel") {
    throw new Error("condition table drifted: cancel");
  }

  console.log(
    `PASS ${FEED}: SPY spot ${spot}, ${expirations.length} expirations, ${mapped.length}/${rows.length} contracts mapped (${withGreeks} with greeks)`,
  );
}

main().catch((err) => {
  console.log(`FAIL ${FEED}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
