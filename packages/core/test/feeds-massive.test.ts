import { describe, expect, it } from "vitest";
import {
  MassiveFeed,
  mapMassiveChainContract,
  mapMassiveTrade,
  massiveExchange,
} from "../src/feeds/massive.js";
import { normalizeTrade } from "../src/normalize/normalize.js";

// All payloads below are invented, vendor-shaped samples — never recordings.
const feed = new MassiveFeed({ apiKey: "test-key" });

describe("massive mappers", () => {
  it("maps a websocket trade event, conditions verbatim as strings", () => {
    const trade = mapMassiveTrade({
      ev: "T",
      sym: "O:NVDA260918C00190000",
      x: 316,
      p: 4.15,
      s: 40,
      c: [209],
      t: 1_787_000_000_123,
      q: 42,
    });
    expect(trade).not.toBeNull();
    expect(trade?.contract).toBe("O:NVDA260918C00190000"); // O: handled by parseOcc
    expect(trade?.ts).toBe(1_787_000_000_123);
    expect(trade?.exchange).toBe("Q"); // 316 = Nasdaq Options Market
    expect(trade?.conditions).toEqual(["209"]);
    expect(trade?.nbbo).toBeNull();
  });

  it("passes trades with no condition array as empty conditions (→ regular)", () => {
    const raw = mapMassiveTrade({
      ev: "T",
      sym: "O:SPY260821P00640000",
      x: 302,
      p: 2.5,
      s: 3,
      t: 1_787_000_000_500,
    });
    expect(raw?.conditions).toEqual([]);
    const { tick } = normalizeTrade(raw as NonNullable<typeof raw>, "massive", 0, (c) =>
      feed.normalizeCondition(c),
    );
    expect(tick?.contract).toBe("SPY260821P00640000"); // canonical, prefix stripped
    expect(tick?.conditions).toEqual(["regular"]);
  });

  it("rejects non-trade events and incomplete trades", () => {
    expect(mapMassiveTrade({ ev: "status" })).toBeNull();
    expect(mapMassiveTrade({ ev: "T", sym: "O:X260101C00001000" })).toBeNull();
  });

  it("maps chain snapshot rows to ChainContracts (ns quote stamps → ms)", () => {
    const contract = mapMassiveChainContract({
      details: {
        ticker: "O:NVDA260918C00190000",
        contract_type: "call",
        expiration_date: "2026-09-18",
        strike_price: 190,
      },
      day: { volume: 812 },
      greeks: { delta: 0.55, gamma: 0.01, theta: -0.08, vega: 0.2 },
      implied_volatility: 0.44,
      open_interest: 5211,
      last_quote: {
        bid: 4.1,
        ask: 4.2,
        bid_size: 11,
        ask_size: 7,
        last_updated: 1_787_000_000_123_000_000,
      },
      underlying_asset: { price: 191.2, ticker: "NVDA" },
    });
    expect(contract).not.toBeNull();
    expect(contract?.contract).toBe("NVDA260918C00190000");
    expect(contract?.right).toBe("C");
    expect(contract?.oi).toBe(5211);
    expect(contract?.iv).toBe(0.44);
    expect(contract?.greeks?.delta).toBe(0.55);
    expect(contract?.nbbo?.ts).toBe(1_787_000_000_123);
    expect(contract?.volume).toBe(812);
  });

  it("maps options exchange ids to OPRA letters, unknown ids pass through", () => {
    expect(massiveExchange(300)).toBe("A");
    expect(massiveExchange(303)).toBe("D"); // MIAX Emerald
    expect(massiveExchange(325)).toBe("Z"); // Cboe BZX
    expect(massiveExchange(65)).toBe("65");
    expect(massiveExchange(undefined)).toBe("?");
  });
});

describe("massive condition table", () => {
  const cases: Array<[number, string]> = [
    [201, "cancel"], // CANC
    [202, "out-of-sequence"], // OSEQ
    [203, "cancel"], // CNCL
    [204, "late"], // LATE
    [205, "cancel"], // CNCO
    [206, "out-of-sequence"], // OPEN
    [207, "cancel"], // CNOL
    [208, "late"], // OPNL
    [209, "auto"], // AUTO
    [210, "reopening"], // REOP
    [219, "iso"], // ISOI
    [227, "auction"], // SLAN
    [228, "auction"], // SLAI
    [229, "cross"], // SLCN
    [230, "cross"], // SLCI
    [231, "floor"], // SLFT
    [232, "spread-leg"], // MLET
    [233, "spread-leg"], // MLAT
    [234, "spread-leg"], // MLCT
    [235, "spread-leg"], // MLFT
    [236, "spread-leg"], // MESL
    [237, "spread-leg-equity"], // TLAT
    [238, "spread-leg"], // MASL
    [239, "spread-leg"], // MFSL
    [240, "spread-leg-equity"], // TLET
    [241, "spread-leg-equity"], // TLCT
    [242, "spread-leg-equity"], // TLFT
    [243, "spread-leg-equity"], // TESL
    [244, "spread-leg-equity"], // TASL
    [245, "spread-leg-equity"], // TFSL
    [246, "spread-leg"], // CBMO
    [247, "cross"], // MCTP
    [248, "late"], // EXHT
  ];

  it("maps the full documented options set (201–210, 219, 227–248)", () => {
    for (const [code, expected] of cases) {
      expect(feed.normalizeCondition(String(code)), `condition ${code}`).toBe(expected);
    }
  });

  it("keeps cancels, spreads and lates apart", () => {
    expect(feed.normalizeCondition("201")).toBe("cancel");
    expect(feed.normalizeCondition("232")).toBe("spread-leg");
    expect(feed.normalizeCondition("204")).toBe("late");
    expect(feed.normalizeCondition("248")).toBe("late");
  });

  it("maps gap/legacy and junk codes to unknown", () => {
    expect(feed.normalizeCondition("211")).toBe("unknown"); // legacy gap
    expect(feed.normalizeCondition("226")).toBe("unknown"); // legacy gap
    expect(feed.normalizeCondition("0")).toBe("unknown"); // stocks-tape code
    expect(feed.normalizeCondition("SLAN")).toBe("unknown");
  });
});
