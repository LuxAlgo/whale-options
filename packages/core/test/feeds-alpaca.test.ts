import { describe, expect, it } from "vitest";
import { AlpacaFeed, mapAlpacaChainContract, mapAlpacaTrade } from "../src/feeds/alpaca.js";
import { msgpackDecode, msgpackEncode } from "../src/feeds/msgpack.js";
import { normalizeTrade } from "../src/normalize/normalize.js";

// All payloads below are invented, vendor-shaped samples — never recordings.
const feed = new AlpacaFeed({ keyId: "key", secretKey: "secret" });

describe("alpaca msgpack codec", () => {
  it("round-trips the control messages the adapter sends", () => {
    const auth = { action: "auth", key: "k".repeat(40), secret: "s".repeat(64) };
    expect(msgpackDecode(msgpackEncode(auth))).toEqual(auth);
    const sub = { action: "subscribe", trades: ["*"] };
    expect(msgpackDecode(msgpackEncode(sub))).toEqual(sub);
  });

  it("round-trips numbers, bools, null and nesting", () => {
    const value = {
      a: 1,
      b: -7,
      c: 1.25,
      d: true,
      e: false,
      f: null,
      g: [1, "two", [3]],
      h: { i: 70000 },
    };
    expect(msgpackDecode(msgpackEncode(value))).toEqual(value);
  });

  it("decodes the msgpack timestamp extension to epoch milliseconds", () => {
    // timestamp64 (ext type -1, 8 bytes): nanos in the top 30 bits, seconds
    // in the low 34. 1,787,000,000s + 500ms.
    const seconds = 1_787_000_000n;
    const nanos = 500_000_000n;
    const packed = (nanos << 34n) | seconds;
    const bytes = new Uint8Array(11);
    bytes[0] = 0x81; // fixmap(1)
    bytes[1] = 0xa1; // fixstr(1)
    bytes[2] = 0x74; // "t"
    const body = new Uint8Array(10);
    body[0] = 0xd7; // fixext8
    body[1] = 0xff; // ext type -1
    new DataView(body.buffer).setBigUint64(2, packed);
    const frame = new Uint8Array([...bytes.subarray(0, 3), ...body]);
    expect(msgpackDecode(frame)).toEqual({ t: 1_787_000_000_500 });
  });

  it("decodes timestamp32 and timestamp96 forms", () => {
    const t32 = new Uint8Array(6);
    t32[0] = 0xd6; // fixext4
    t32[1] = 0xff;
    new DataView(t32.buffer).setUint32(2, 1_787_000_000);
    expect(msgpackDecode(t32)).toBe(1_787_000_000_000);

    const t96 = new Uint8Array(16); // 0xc8 + len(2) + type(1) + 12 data bytes
    t96[0] = 0xc8; // ext16
    new DataView(t96.buffer).setUint16(1, 12);
    t96[3] = 0xff;
    new DataView(t96.buffer).setUint32(4, 250_000_000); // nanos
    new DataView(t96.buffer).setBigInt64(8, 1_787_000_000n);
    expect(msgpackDecode(t96)).toBe(1_787_000_000_250);
  });
});

describe("alpaca mappers", () => {
  it("maps a stream trade (condition is a single OPRA letter)", () => {
    const trade = mapAlpacaTrade({
      T: "t",
      S: "NVDA260918C00190000",
      t: 1_787_000_000_123,
      p: 4.05,
      s: 12,
      x: "C",
      c: "I",
    });
    expect(trade).not.toBeNull();
    expect(trade?.contract).toBe("NVDA260918C00190000");
    expect(trade?.exchange).toBe("C");
    expect(trade?.conditions).toEqual(["I"]);
    const { tick } = normalizeTrade(trade as NonNullable<typeof trade>, "alpaca", 0, (c) =>
      feed.normalizeCondition(c),
    );
    expect(tick?.conditions).toEqual(["auto"]);
  });

  it("accepts RFC3339 timestamps and condition arrays", () => {
    const trade = mapAlpacaTrade({
      T: "t",
      S: "SPY260821P00640000",
      t: "2026-08-24T13:30:00.123456789Z",
      p: 2.1,
      s: 4,
      x: "B",
      c: ["f"],
    });
    expect(trade?.ts).toBe(Date.parse("2026-08-24T13:30:00.123Z"));
    expect(trade?.conditions).toEqual(["f"]);
  });

  it("rejects non-trade messages", () => {
    expect(mapAlpacaTrade({ T: "q", S: "SPY260821P00640000" })).toBeNull();
    expect(mapAlpacaTrade({ T: "t" })).toBeNull();
  });

  it("maps a chain snapshot entry (no OI at this vendor)", () => {
    const contract = mapAlpacaChainContract("NVDA260918C00190000", {
      latestQuote: {
        t: "2026-08-24T13:30:00.5Z",
        bp: 4.0,
        bs: 10,
        ap: 4.2,
        as: 6,
      },
      impliedVolatility: 0.41,
      greeks: { delta: 0.52, gamma: 0.012, theta: -0.07, vega: 0.19, rho: 0.05 },
    });
    expect(contract?.contract).toBe("NVDA260918C00190000");
    expect(contract?.oi).toBeNull();
    expect(contract?.iv).toBe(0.41);
    expect(contract?.greeks?.vega).toBe(0.19);
    expect(contract?.nbbo?.bid).toBe(4.0);
    expect(contract?.nbbo?.ts).toBe(Date.parse("2026-08-24T13:30:00.5Z"));
  });
});

describe("alpaca condition table (OPRA letters, case-significant)", () => {
  const cases: Array<[string, string]> = [
    ["A", "cancel"], // CANC
    ["B", "out-of-sequence"], // OSEQ
    ["C", "cancel"], // CNCL
    ["D", "late"], // LATE
    ["E", "cancel"], // CNCO
    ["F", "out-of-sequence"], // OPEN
    ["G", "cancel"], // CNOL
    ["H", "late"], // OPNL
    ["I", "auto"], // AUTO
    ["J", "reopening"], // REOP
    ["S", "iso"], // ISOI
    ["a", "auction"], // SLAN
    ["b", "auction"], // SLAI
    ["c", "cross"], // SLCN
    ["d", "cross"], // SLCI
    ["e", "floor"], // SLFT
    ["f", "spread-leg"], // MLET
    ["g", "spread-leg"], // MLAT
    ["h", "spread-leg"], // MLCT
    ["i", "spread-leg"], // MLFT
    ["j", "spread-leg"], // MESL
    ["k", "spread-leg-equity"], // TLAT
    ["l", "spread-leg"], // MASL
    ["m", "spread-leg"], // MFSL
    ["n", "spread-leg-equity"], // TLET
    ["o", "spread-leg-equity"], // TLCT
    ["p", "spread-leg-equity"], // TLFT
    ["q", "spread-leg-equity"], // TESL
    ["r", "spread-leg-equity"], // TASL
    ["s", "spread-leg-equity"], // TFSL
    ["t", "spread-leg"], // CBMO
    ["u", "cross"], // MCTP
    ["v", "late"], // EXHT
    // legacy pre-Pillar letters
    ["K", "regular"], // AJST
    ["L", "spread-leg"], // SPRD
    ["M", "spread-leg"], // STDL
    ["N", "regular"], // STPD
    ["O", "cancel"], // CSTP
    ["P", "spread-leg-equity"], // BWRT
    ["Q", "spread-leg"], // CMBO
    ["R", "regular"], // SPIM
    ["T", "cross"], // BNMT
    ["X", "regular"], // XMPT
  ];

  it("maps the full letter set", () => {
    for (const [code, expected] of cases) {
      expect(feed.normalizeCondition(code), `condition "${code}"`).toBe(expected);
    }
  });

  it("treats case as significant (a=SLAN auction vs A=CANC cancel)", () => {
    expect(feed.normalizeCondition("a")).toBe("auction");
    expect(feed.normalizeCondition("A")).toBe("cancel");
    expect(feed.normalizeCondition("s")).toBe("spread-leg-equity");
    expect(feed.normalizeCondition("S")).toBe("iso");
  });

  it("maps unknown letters to unknown", () => {
    expect(feed.normalizeCondition("Z")).toBe("unknown");
    expect(feed.normalizeCondition("w")).toBe("unknown");
    expect(feed.normalizeCondition("")).toBe("unknown");
  });
});
