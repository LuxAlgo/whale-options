import { describe, expect, it } from "vitest";
import {
  etTimestampToUtc,
  mapThetaQuote,
  mapThetaTrade,
  ThetadataFeed,
  type ThetaStreamMessage,
  thetaContractToOcc,
  thetaDateToIso,
  thetaExchange,
  thetaTimestampToUtc,
} from "../src/feeds/thetadata.js";
import { normalizeTrade } from "../src/normalize/normalize.js";
import { easternTimeToUtc } from "../src/util/session.js";

// All payloads below are invented, vendor-shaped samples — never recordings.
const feed = new ThetadataFeed();

function tradeFrame(overrides: Partial<NonNullable<ThetaStreamMessage["trade"]>> = {}) {
  return {
    header: { type: "TRADE", status: "CONNECTED" },
    contract: {
      security_type: "OPTION",
      root: "NVDA",
      expiration: 20260918,
      strike: 190000,
      right: "C",
    },
    trade: {
      ms_of_day: 34_200_000, // 09:30:00 ET
      sequence: 1234,
      size: 25,
      condition: 18,
      price: 4.2,
      exchange: 65,
      date: 20260824,
      ...overrides,
    },
  } satisfies ThetaStreamMessage;
}

describe("thetadata mappers", () => {
  it("converts terminal dates and Eastern wall-clock times", () => {
    expect(thetaDateToIso(20260918)).toBe("2026-09-18");
    expect(thetaDateToIso(123)).toBeNull();
    // 09:30 ET as date + ms_of_day equals the session helper's answer (EDT).
    expect(thetaTimestampToUtc(20260824, 34_200_000)).toBe(easternTimeToUtc("2026-08-24", 9, 30));
    // And in winter (EST) too.
    expect(thetaTimestampToUtc(20260115, 36_000_000)).toBe(easternTimeToUtc("2026-01-15", 10, 0));
    expect(etTimestampToUtc("2026-08-24T09:30:00.471")).toBe(
      easternTimeToUtc("2026-08-24", 9, 30) + 471,
    );
    expect(etTimestampToUtc("2026-01-15T10:00:00")).toBe(easternTimeToUtc("2026-01-15", 10, 0));
  });

  it("builds canonical OCC symbols from stream contracts (strike in 1/10 cent)", () => {
    expect(
      thetaContractToOcc({
        security_type: "OPTION",
        root: "NVDA",
        expiration: 20260918,
        strike: 190000,
        right: "C",
      }),
    ).toBe("NVDA260918C00190000");
    expect(thetaContractToOcc({ root: "AAPL", expiration: 20260918, strike: 0, right: "C" })).toBe(
      null,
    );
    expect(
      thetaContractToOcc({
        security_type: "STOCK",
        root: "AAPL",
        expiration: 20260918,
        strike: 190000,
        right: "C",
      }),
    ).toBeNull();
  });

  it("maps a TRADE frame to a RawOptionTrade with the vendor condition verbatim", () => {
    const trade = mapThetaTrade(tradeFrame());
    expect(trade).not.toBeNull();
    expect(trade?.contract).toBe("NVDA260918C00190000");
    expect(trade?.ts).toBe(easternTimeToUtc("2026-08-24", 9, 30));
    expect(trade?.price).toBe(4.2);
    expect(trade?.size).toBe(25);
    expect(trade?.exchange).toBe("E"); // 65 = Cboe EDGX
    expect(trade?.conditions).toEqual(["18"]);
    expect(trade?.nbbo).toBeNull();
  });

  it("ignores non-trade frames and attaches cached NBBO when provided", () => {
    expect(mapThetaTrade({ header: { type: "STATUS" } })).toBeNull();
    const quote = mapThetaQuote({
      header: { type: "QUOTE" },
      contract: {
        security_type: "OPTION",
        root: "NVDA",
        expiration: 20260918,
        strike: 190000,
        right: "C",
      },
      quote: {
        ms_of_day: 34_199_900,
        bid: 4.1,
        bid_size: 12,
        ask: 4.3,
        ask_size: 9,
        date: 20260824,
      },
    });
    expect(quote?.contract).toBe("NVDA260918C00190000");
    expect(quote?.nbbo.bid).toBe(4.1);
    expect(quote?.nbbo.askSize).toBe(9);
    const trade = mapThetaTrade(tradeFrame(), quote?.nbbo ?? null);
    expect(trade?.nbbo?.ask).toBe(4.3);
  });

  it("maps exchange ids to OPRA letters and passes unknown ids through", () => {
    expect(thetaExchange(5)).toBe("C");
    expect(thetaExchange(43)).toBe("M");
    expect(thetaExchange(69)).toBe("P");
    expect(thetaExchange(999)).toBe("999");
    expect(thetaExchange(undefined)).toBe("?");
  });

  it("feeds normalizeTrade end to end (condition mapped through the table)", () => {
    const raw = mapThetaTrade(tradeFrame({ condition: 130 })); // MLET
    expect(raw).not.toBeNull();
    const { tick } = normalizeTrade(raw as NonNullable<typeof raw>, "thetadata", 0, (c) =>
      feed.normalizeCondition(c),
    );
    expect(tick?.conditions).toEqual(["spread-leg"]);
    expect(tick?.underlying).toBe("NVDA");
  });
});

describe("thetadata condition table", () => {
  const cases: Array<[number, string]> = [
    [0, "regular"],
    [1, "late"], // FORM_T
    [2, "out-of-sequence"],
    [5, "late"],
    [6, "out-of-sequence"],
    [7, "late"],
    [13, "late"],
    [18, "auto"],
    [21, "reopening"],
    [34, "regular"], // adjusted terms
    [35, "spread-leg"], // SPREAD
    [36, "spread-leg"], // STRADDLE
    [37, "spread-leg-equity"], // BUY_WRITE
    [38, "spread-leg"], // COMBO
    [39, "regular"], // stopped
    [40, "cancel"], // CANC
    [41, "cancel"], // CANC_LAST
    [42, "cancel"], // CANC_OPEN
    [43, "cancel"], // CANC_ONLY
    [44, "cancel"], // CANC_STPD
    [92, "auction"], // closing auction
    [95, "iso"],
    [97, "reopening"],
    [105, "spread-leg-equity"], // stock option
    [106, "regular"],
    [107, "cross"], // benchmark
    [108, "regular"], // trade-through exempt
    [118, "late"], // OPRA extended hours
    [124, "cross"], // qualified contingent trade
    [125, "auction"], // SLAN
    [126, "auction"], // SLAI
    [127, "cross"], // SLCN
    [128, "cross"], // SLCI
    [129, "floor"], // SLFT
    [130, "spread-leg"], // MLET
    [131, "spread-leg"], // MLAT
    [132, "spread-leg"], // MLCT
    [133, "spread-leg"], // MLFT
    [134, "spread-leg"], // MESL
    [135, "spread-leg-equity"], // TLAT
    [136, "spread-leg"], // MASL
    [137, "spread-leg"], // MFSL
    [138, "spread-leg-equity"], // TLET
    [139, "spread-leg-equity"], // TLCT
    [140, "spread-leg-equity"], // TLFT
    [141, "spread-leg-equity"], // TESL
    [142, "spread-leg-equity"], // TASL
    [143, "spread-leg-equity"], // TFSL
    [144, "spread-leg"], // CBMO
    [147, "cross"], // MCTP
    [148, "late"], // EXHT
  ];

  it("maps every documented options condition", () => {
    for (const [code, expected] of cases) {
      expect(feed.normalizeCondition(String(code)), `condition ${code}`).toBe(expected);
    }
  });

  it("sends spread, cancel and late families where the policy table expects them", () => {
    expect(feed.normalizeCondition("130")).toBe("spread-leg");
    expect(feed.normalizeCondition("40")).toBe("cancel");
    expect(feed.normalizeCondition("4")).toBe("unknown"); // AVG_PRC_NASDAQ — not OPRA
    expect(feed.normalizeCondition("5")).toBe("late");
  });

  it("maps unknown codes to unknown", () => {
    expect(feed.normalizeCondition("999")).toBe("unknown");
    expect(feed.normalizeCondition("not-a-number")).toBe("unknown");
    expect(feed.normalizeCondition("145")).toBe("unknown"); // BID_AGGRESSOR — not OPRA
  });
});
