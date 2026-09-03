import { describe, expect, it } from "vitest";
import { blackScholes, normCdf } from "../src/greeks/black-scholes.js";
import { solveIv } from "../src/greeks/brent.js";
import { computeGex } from "../src/greeks/gex.js";
import { computeGexHeatmap } from "../src/greeks/gex-heatmap.js";
import { formatOcc } from "../src/occ.js";
import type { ChainSnapshot } from "../src/types.js";
import { easternTimeToUtc } from "../src/util/session.js";

describe("black-scholes", () => {
  it("matches a textbook value (S=100, K=100, τ=1, σ=0.2, r=0.05)", () => {
    const call = blackScholes({
      spot: 100,
      strike: 100,
      tau: 1,
      iv: 0.2,
      r: 0.05,
      q: 0,
      right: "C",
    });
    const put = blackScholes({
      spot: 100,
      strike: 100,
      tau: 1,
      iv: 0.2,
      r: 0.05,
      q: 0,
      right: "P",
    });
    expect(call.price).toBeCloseTo(10.4506, 3);
    expect(put.price).toBeCloseTo(5.5735, 3);
  });

  it("satisfies put-call parity with dividends", () => {
    const args = { spot: 250, strike: 240, tau: 0.35, iv: 0.4, r: 0.05, q: 0.012 };
    const call = blackScholes({ ...args, right: "C" as const }).price;
    const put = blackScholes({ ...args, right: "P" as const }).price;
    const parity =
      args.spot * Math.exp(-args.q * args.tau) - args.strike * Math.exp(-args.r * args.tau);
    expect(call - put).toBeCloseTo(parity, 8);
  });

  it("gamma is identical for calls and puts and peaks near ATM", () => {
    const base = { spot: 100, tau: 0.1, iv: 0.3, r: 0.05, q: 0 };
    const atmC = blackScholes({ ...base, strike: 100, right: "C" }).gamma;
    const atmP = blackScholes({ ...base, strike: 100, right: "P" }).gamma;
    const otm = blackScholes({ ...base, strike: 130, right: "C" }).gamma;
    expect(atmC).toBeCloseTo(atmP, 12);
    expect(atmC).toBeGreaterThan(otm);
  });

  it("normCdf approximation is accurate", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 3);
  });
});

describe("implied vol (brent)", () => {
  it("round-trips price → IV → price", () => {
    for (const [strike, iv] of [
      [90, 0.25],
      [100, 0.4],
      [120, 0.6],
    ] as const) {
      const price = blackScholes({
        spot: 100,
        strike,
        tau: 0.2,
        iv,
        r: 0.05,
        q: 0,
        right: "C",
      }).price;
      const solved = solveIv({
        targetPrice: price,
        spot: 100,
        strike,
        tau: 0.2,
        r: 0.05,
        q: 0,
        right: "C",
      });
      expect(solved).not.toBeNull();
      expect(solved ?? 0).toBeCloseTo(iv, 4);
    }
  });

  it("returns null below intrinsic (no-arbitrage violation)", () => {
    const solved = solveIv({
      targetPrice: 5,
      spot: 120,
      strike: 100,
      tau: 0.1,
      r: 0,
      q: 0,
      right: "C",
    });
    expect(solved).toBeNull();
  });
});

describe("gex", () => {
  function snapshot(): ChainSnapshot {
    const ts = easternTimeToUtc("2026-08-24", 12);
    const expiry = "2026-09-18";
    const contracts = [];
    for (const strike of [180, 190, 200, 210, 220]) {
      for (const right of ["C", "P"] as const) {
        contracts.push({
          contract: formatOcc("NVDA", expiry, right, strike),
          underlying: "NVDA",
          expiry,
          strike,
          right,
          // Put OI heavier below spot, call OI heavier above — the classic shape.
          oi: right === "C" ? (strike >= 200 ? 5000 : 1500) : strike <= 200 ? 5000 : 1500,
          iv: 0.42,
        });
      }
    }
    return { underlying: "NVDA", ts, spot: 200, contracts };
  }

  it("signs calls positive and puts negative under the default convention", () => {
    const gex = computeGex(snapshot(), {
      r: 0.05,
      q: 0,
      convention: "dealer-long-calls-short-puts",
    });
    expect(gex).not.toBeNull();
    for (const row of gex?.perStrike ?? []) {
      if (row.callOi > 0) expect(row.callGex).toBeGreaterThan(0);
      if (row.putOi > 0) expect(row.putGex).toBeLessThan(0);
    }
    expect(gex?.conventionNote).toContain("assumption");
  });

  it("flipping the convention flips the ladder", () => {
    const a = computeGex(snapshot(), { r: 0.05, q: 0, convention: "dealer-long-calls-short-puts" });
    const b = computeGex(snapshot(), { r: 0.05, q: 0, convention: "dealer-short-calls-long-puts" });
    expect(a?.totalGex).toBeCloseTo(-(b?.totalGex ?? 0), 6);
  });

  it("finds a zero-gamma level between the put-heavy and call-heavy sides", () => {
    const gex = computeGex(snapshot(), {
      r: 0.05,
      q: 0,
      convention: "dealer-long-calls-short-puts",
    });
    expect(gex?.zeroGamma).not.toBeNull();
    const level = gex?.zeroGamma?.level ?? 0;
    expect(level).toBeGreaterThan(180);
    expect(level).toBeLessThan(220);
    expect(gex?.zeroGamma?.method).toContain("spot scan");
  });
});

describe("gex: live re-pricing and the heatmap", () => {
  function chain(): ChainSnapshot {
    const ts = easternTimeToUtc("2026-08-24", 12);
    const contracts = [];
    for (const expiry of ["2026-08-28", "2026-09-18"]) {
      for (const strike of [170, 180, 190, 200, 210, 220, 230]) {
        for (const right of ["C", "P"] as const) {
          contracts.push({
            contract: formatOcc("NVDA", expiry, right, strike),
            underlying: "NVDA",
            expiry,
            strike,
            right,
            oi: right === "C" ? (strike >= 200 ? 4000 : 1000) : strike <= 200 ? 4000 : 1000,
            iv: expiry === "2026-08-28" ? 0.5 : 0.42,
          });
        }
      }
    }
    return { underlying: "NVDA", ts, spot: 200, contracts };
  }
  const opts = { r: 0.05, q: 0, convention: "dealer-long-calls-short-puts" as const };

  it("states the snapshot's own pricing by default", () => {
    const gex = computeGex(chain(), opts);
    expect(gex?.pricing.spotSource).toBe("chain-snapshot");
    expect(gex?.pricing.spot).toBe(200);
    expect(gex?.pricing.repricedTs).toBeNull();
    expect(gex?.pricing.note).toContain("chain as of 2026-08-24T16:00:00.000Z");
    expect(gex?.pricing.note).toContain("snapshot's own spot 200");
  });

  it("re-prices at an override spot without touching OI, and says when", () => {
    const base = computeGex(chain(), opts);
    const repricedTs = easternTimeToUtc("2026-08-24", 12, 30);
    const moved = computeGex(chain(), { ...opts, spot: 206, repricedTs });
    expect(moved?.spot).toBe(206);
    expect(moved?.pricing).toMatchObject({
      chainTs: chain().ts,
      spot: 206,
      spotSource: "override",
      repricedTs,
    });
    expect(moved?.pricing.note).toBe(
      "chain as of 2026-08-24T16:00:00.000Z, re-priced at spot 206 at 2026-08-24T16:30:00.000Z (OI, IV, and feed greeks are still the snapshot's)",
    );
    // Same OI, same strikes — only the gamma weights moved with spot.
    expect(moved?.perStrike.map((r) => [r.strike, r.callOi, r.putOi])).toEqual(
      base?.perStrike.map((r) => [r.strike, r.callOi, r.putOi]),
    );
    expect(moved?.totalGex).not.toBe(base?.totalGex);
    expect(moved?.conventionNote).toBe(base?.conventionNote); // verbatim, always
    // A junk override is ignored, not obeyed.
    expect(computeGex(chain(), { ...opts, spot: -3 })?.pricing.spotSource).toBe("chain-snapshot");
  });

  it("the heatmap's cells sum to the ladder along both axes", () => {
    const heat = computeGexHeatmap(chain(), { ...opts, rows: 5 });
    const all = computeGex(chain(), opts);
    expect(heat).not.toBeNull();
    expect(heat?.expiries).toEqual(["2026-08-28", "2026-09-18"]);
    expect(heat?.strikes).toEqual([180, 190, 200, 210, 220]); // 5 nearest to spot 200
    expect(heat?.strikesOmitted).toBe(2); // 170 and 230
    expect(heat?.spotRowIndex).toBe(2);
    expect(heat?.cells).toHaveLength(5);
    // Row sums equal the all-expiry ladder at that strike …
    heat?.strikes.forEach((strike, i) => {
      const rowSum = (heat.cells[i] ?? []).reduce((a, v) => a + v, 0);
      const ladderRow = all?.perStrike.find((r) => r.strike === strike)?.netGex ?? Number.NaN;
      expect(rowSum).toBeCloseTo(ladderRow, 1);
      expect(heat.strikeTotals[i]).toBe(ladderRow);
    });
    // … and each expiry total equals that expiry's own whole ladder.
    heat?.expiries.forEach((expiry, j) => {
      const own = computeGex(chain(), { ...opts, expiry });
      expect(heat.expiryTotals[j]).toBe(own?.totalGex);
    });
    expect(heat?.totalGex).toBe(all?.totalGex);
    expect(heat?.zeroGamma).toEqual(all?.zeroGamma);
    expect(heat?.conventionNote).toBe(all?.conventionNote);
    expect(heat?.pricing.spotSource).toBe("chain-snapshot");
    expect(heat?.note).toContain("per 1% spot move");
  });

  it("the heatmap re-prices too and carries the same pricing line", () => {
    const ts = easternTimeToUtc("2026-08-24", 13);
    const heat = computeGexHeatmap(chain(), { ...opts, spot: 195, repricedTs: ts });
    expect(heat?.spot).toBe(195);
    expect(heat?.pricing.spotSource).toBe("override");
    expect(heat?.pricing.note).toContain("re-priced at spot 195 at 2026-08-24T17:00:00.000Z");
    expect(heat?.strikes).toHaveLength(7); // default rows (21) keeps the whole small chain
    expect(heat?.strikesOmitted).toBe(0);
  });

  it("is deterministic", () => {
    const a = JSON.stringify(computeGexHeatmap(chain(), { ...opts, spot: 203, repricedTs: 1 }));
    const b = JSON.stringify(computeGexHeatmap(chain(), { ...opts, spot: 203, repricedTs: 1 }));
    expect(a).toBe(b);
  });
});
