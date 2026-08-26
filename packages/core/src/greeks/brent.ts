/*
  Brent's method root finder + the implied-vol solve built on it. Brent is
  the workhorse here because option-price-vs-vol is well behaved inside the
  bracket but Newton (vega-based) diverges on deep OTM/near-expiry contracts.
*/

import type { Right } from "../types.js";
import { blackScholes, intrinsicValue } from "./black-scholes.js";

export function brent(
  f: (x: number) => number,
  lo: number,
  hi: number,
  tol = 1e-7,
  maxIter = 100,
): number | null {
  let a = lo;
  let b = hi;
  let fa = f(a);
  let fb = f(b);
  if (!Number.isFinite(fa) || !Number.isFinite(fb) || fa * fb > 0) return null;
  if (Math.abs(fa) < Math.abs(fb)) {
    [a, b] = [b, a];
    [fa, fb] = [fb, fa];
  }
  let c = a;
  let fc = fa;
  let mflag = true;
  let d = a;

  for (let i = 0; i < maxIter; i++) {
    if (fb === 0 || Math.abs(b - a) < tol) return b;
    let s: number;
    if (fa !== fc && fb !== fc) {
      // inverse quadratic interpolation
      s =
        (a * fb * fc) / ((fa - fb) * (fa - fc)) +
        (b * fa * fc) / ((fb - fa) * (fb - fc)) +
        (c * fa * fb) / ((fc - fa) * (fc - fb));
    } else {
      s = b - fb * ((b - a) / (fb - fa)); // secant
    }
    const between = (3 * a + b) / 4;
    const cond1 = !(s > Math.min(between, b) && s < Math.max(between, b));
    const cond2 = mflag && Math.abs(s - b) >= Math.abs(b - c) / 2;
    const cond3 = !mflag && Math.abs(s - b) >= Math.abs(c - d) / 2;
    const cond4 = mflag && Math.abs(b - c) < tol;
    const cond5 = !mflag && Math.abs(c - d) < tol;
    if (cond1 || cond2 || cond3 || cond4 || cond5) {
      s = (a + b) / 2; // bisection fallback
      mflag = true;
    } else {
      mflag = false;
    }
    const fs = f(s);
    d = c;
    c = b;
    fc = fb;
    if (fa * fs < 0) {
      b = s;
      fb = fs;
    } else {
      a = s;
      fa = fs;
    }
    if (Math.abs(fa) < Math.abs(fb)) {
      [a, b] = [b, a];
      [fa, fb] = [fb, fa];
    }
  }
  return b;
}

export interface IvSolveInput {
  targetPrice: number;
  spot: number;
  strike: number;
  tau: number;
  r: number;
  q: number;
  right: Right;
}

/** Solve IV from a market price. Null when the price sits outside no-arbitrage bounds. */
export function solveIv(input: IvSolveInput): number | null {
  const { targetPrice, spot, strike, tau, r, q, right } = input;
  if (tau <= 0 || targetPrice <= 0 || spot <= 0) return null;
  // Discounted intrinsic is the price floor; anything at/below it has no IV.
  const floor = intrinsicValue(spot * Math.exp(-q * tau), strike * Math.exp(-r * tau), right);
  if (targetPrice <= floor + 1e-9) return null;
  const f = (iv: number) =>
    blackScholes({ spot, strike, tau, iv, r, q, right }).price - targetPrice;
  return brent(f, 1e-4, 5.0);
}
