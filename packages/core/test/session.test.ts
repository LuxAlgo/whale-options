import { describe, expect, it } from "vitest";
import { dteOf, easternOffsetMs, easternTimeToUtc, sessionDateOf } from "../src/util/session.js";

const HOUR = 3_600_000;

describe("eastern session math", () => {
  it("uses EDT (-4h) in summer and EST (-5h) in winter", () => {
    expect(easternOffsetMs(Date.UTC(2026, 7, 24, 12))).toBe(-4 * HOUR); // Aug
    expect(easternOffsetMs(Date.UTC(2026, 0, 15, 12))).toBe(-5 * HOUR); // Jan
  });

  it("handles the 2026 DST boundaries (Mar 8, Nov 1)", () => {
    // Second Sunday of March 2026 is the 8th: 06:59 UTC still EST, 07:00 EDT.
    expect(easternOffsetMs(Date.UTC(2026, 2, 8, 6, 59))).toBe(-5 * HOUR);
    expect(easternOffsetMs(Date.UTC(2026, 2, 8, 7, 0))).toBe(-4 * HOUR);
    // First Sunday of November 2026 is the 1st: 05:59 UTC EDT, 06:00 EST.
    expect(easternOffsetMs(Date.UTC(2026, 10, 1, 5, 59))).toBe(-4 * HOUR);
    expect(easternOffsetMs(Date.UTC(2026, 10, 1, 6, 0))).toBe(-5 * HOUR);
  });

  it("computes session dates across midnight UTC", () => {
    // 01:00 UTC on Aug 25 is still 21:00 ET on Aug 24.
    expect(sessionDateOf(Date.UTC(2026, 7, 25, 1))).toBe("2026-08-24");
    expect(sessionDateOf(Date.UTC(2026, 7, 25, 12))).toBe("2026-08-25");
  });

  it("converts eastern wall clock to UTC", () => {
    // 09:30 ET on 2026-08-24 (EDT) = 13:30 UTC.
    expect(easternTimeToUtc("2026-08-24", 9, 30)).toBe(Date.UTC(2026, 7, 24, 13, 30));
    // 09:30 ET on 2026-01-15 (EST) = 14:30 UTC.
    expect(easternTimeToUtc("2026-01-15", 9, 30)).toBe(Date.UTC(2026, 0, 15, 14, 30));
  });

  it("measures DTE to the 16:00 ET close and floors at zero", () => {
    const noonEt = easternTimeToUtc("2026-08-24", 12);
    expect(dteOf(noonEt, "2026-08-24")).toBeCloseTo(4 / 24, 6);
    expect(dteOf(noonEt, "2026-08-28")).toBeCloseTo(4 + 4 / 24, 6);
    const afterClose = easternTimeToUtc("2026-08-24", 17);
    expect(dteOf(afterClose, "2026-08-24")).toBe(0);
  });
});
