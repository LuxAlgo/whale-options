import { describe, expect, it } from "vitest";
import {
  list,
  mapTradierChainOption,
  mapTradierTimesale,
  TradierFeed,
} from "../src/feeds/tradier.js";
import { normalizeTrade } from "../src/normalize/normalize.js";

// All payloads below are invented, vendor-shaped samples — never recordings.
const feed = new TradierFeed({ accessToken: "test-token" });

describe("tradier list() — object-or-array-or-null normalization", () => {
  it("passes arrays through", () => {
    expect(list([1, 2, 3])).toEqual([1, 2, 3]);
    expect(list([])).toEqual([]);
  });

  it("wraps a bare single object (Tradier collapses 1-element collections)", () => {
    expect(list({ symbol: "SPY" })).toEqual([{ symbol: "SPY" }]);
    expect(list("2026-09-18")).toEqual(["2026-09-18"]);
  });

  it('normalizes empties: null, undefined and the literal string "null"', () => {
    expect(list(null)).toEqual([]);
    expect(list(undefined)).toEqual([]);
    expect(list("null")).toEqual([]);
  });
});

describe("tradier timesale mapper", () => {
  const baseEvent = {
    type: "timesale",
    symbol: "NVDA260918C00190000",
    exch: "Q",
    bid: "4.10",
    ask: "4.20",
    last: "4.20",
    size: "15",
    date: "1787000000123",
    seq: 7,
    flag: "",
    cancel: false,
    correction: false,
    session: "normal",
  };

  it("maps a clean print with NBBO-at-print riding along, numeric strings parsed", () => {
    const trade = mapTradierTimesale(baseEvent);
    expect(trade).not.toBeNull();
    expect(trade?.contract).toBe("NVDA260918C00190000");
    expect(trade?.ts).toBe(1_787_000_000_123);
    expect(trade?.price).toBe(4.2);
    expect(trade?.size).toBe(15);
    expect(trade?.exchange).toBe("Q");
    expect(trade?.conditions).toEqual([]); // → "regular" after normalize
    expect(trade?.nbbo).toEqual({
      bid: 4.1,
      ask: 4.2,
      bidSize: 0,
      askSize: 0,
      ts: 1_787_000_000_123,
    });
  });

  it("synthesizes cancel / correction / session tokens as conditions", () => {
    expect(mapTradierTimesale({ ...baseEvent, cancel: true })?.conditions).toEqual(["cancel"]);
    expect(mapTradierTimesale({ ...baseEvent, correction: true })?.conditions).toEqual([
      "correction",
    ]);
    expect(mapTradierTimesale({ ...baseEvent, session: "post" })?.conditions).toEqual([
      "session:post",
    ]);
    expect(mapTradierTimesale({ ...baseEvent, flag: "X", cancel: true })?.conditions).toEqual([
      "X",
      "cancel",
    ]);
  });

  it("skips non-timesale events and non-option symbols", () => {
    expect(mapTradierTimesale({ ...baseEvent, type: "quote" })).toBeNull();
    expect(mapTradierTimesale({ ...baseEvent, symbol: "SPY" })).toBeNull();
    expect(mapTradierTimesale({ ...baseEvent, last: "not-a-number" })).toBeNull();
  });

  it("feeds normalizeTrade end to end (cancel print stays a cancel)", () => {
    const raw = mapTradierTimesale({ ...baseEvent, cancel: true });
    const { tick } = normalizeTrade(raw as NonNullable<typeof raw>, "tradier", 0, (c) =>
      feed.normalizeCondition(c),
    );
    expect(tick?.conditions).toEqual(["cancel"]);
    expect(tick?.nbbo?.bid).toBe(4.1);
  });
});

describe("tradier chain mapper", () => {
  it("maps a chain row with ORATS greeks and open interest", () => {
    const contract = mapTradierChainOption({
      symbol: "NVDA260918P00180000",
      bid: 3.0,
      ask: 3.2,
      bidsize: 21,
      asksize: 14,
      bid_date: 1_787_000_000_000,
      ask_date: 1_787_000_000_400,
      strike: 180,
      open_interest: 913,
      volume: 55,
      expiration_date: "2026-09-18",
      option_type: "put",
      underlying: "NVDA",
      greeks: { delta: -0.42, gamma: 0.01, theta: -0.06, vega: 0.18, mid_iv: 0.47, smv_vol: 0.46 },
    });
    expect(contract).not.toBeNull();
    expect(contract?.contract).toBe("NVDA260918P00180000");
    expect(contract?.right).toBe("P");
    expect(contract?.oi).toBe(913);
    expect(contract?.iv).toBe(0.47); // mid_iv preferred over smv_vol
    expect(contract?.greeks?.delta).toBe(-0.42);
    expect(contract?.nbbo?.ts).toBe(1_787_000_000_400); // newer side wins
  });

  it("returns null for rows without a parsable OCC symbol", () => {
    expect(
      mapTradierChainOption({ symbol: "NVDA", expiration_date: "2026-09-18", strike: 1 }),
    ).toBe(null);
  });
});

describe("tradier condition table", () => {
  it("maps the documented signal set", () => {
    expect(feed.normalizeCondition("")).toBe("regular");
    expect(feed.normalizeCondition("cancel")).toBe("cancel");
    expect(feed.normalizeCondition("correction")).toBe("late");
    expect(feed.normalizeCondition("session:pre")).toBe("late");
    expect(feed.normalizeCondition("session:post")).toBe("late");
  });

  it("maps undocumented flag letters to unknown (engine keeps but marks them)", () => {
    expect(feed.normalizeCondition("X")).toBe("unknown");
    expect(feed.normalizeCondition("I")).toBe("unknown");
    expect(feed.normalizeCondition("7")).toBe("unknown");
  });
});
