import { describe, expect, it } from "vitest";
import { formatOcc, formatOsi, parseOcc } from "../src/occ.js";

describe("occ symbology", () => {
  it("parses a canonical unpadded symbol", () => {
    const c = parseOcc("NVDA260918C00120000");
    expect(c).toEqual({
      occ: "NVDA260918C00120000",
      underlying: "NVDA",
      expiry: "2026-09-18",
      strike: 120,
      right: "C",
    });
  });

  it("parses vendor variants: O: prefix, dot prefix, OSI padding, lowercase", () => {
    const expected = parseOcc("SPY260821P00640000");
    expect(parseOcc("O:SPY260821P00640000")).toEqual(expected);
    expect(parseOcc(".SPY260821P00640000")).toEqual(expected);
    expect(parseOcc("SPY   260821P00640000")).toEqual(expected);
    expect(parseOcc("spy260821p00640000")).toEqual(expected);
  });

  it("handles fractional strikes", () => {
    const c = parseOcc("AMD261016C00162500");
    expect(c?.strike).toBe(162.5);
    expect(formatOcc("AMD", "2026-10-16", "C", 162.5)).toBe("AMD261016C00162500");
  });

  it("round-trips format → parse", () => {
    const occ = formatOcc("TSLA", "2026-12-18", "P", 300);
    expect(parseOcc(occ)?.occ).toBe(occ);
  });

  it("formats OSI with a padded root", () => {
    expect(formatOsi("F", "2026-09-18", "C", 12)).toBe("F     260918C00012000");
  });

  it("rejects junk", () => {
    expect(parseOcc("")).toBeNull();
    expect(parseOcc("NVDA")).toBeNull();
    expect(parseOcc("NVDA269918C00120000")).toBeNull(); // month 99
    expect(parseOcc("NVDA260918X00120000")).toBeNull(); // right X
  });
});
