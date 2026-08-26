/*
  Black–Scholes with continuous dividend yield. Used when the feed provides
  no greeks: IV solved from the quote mid (Brent), gamma/delta/vega computed
  here. Normal CDF via the Abramowitz–Stegun 7.1.26 erf approximation
  (|error| < 1.5e-7) — no Intl, no dependencies, fully deterministic.
*/
import type { Right } from "../types.js";

export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export interface BsInput {
  spot: number;
  strike: number;
  /** Time to expiry in years. */
  tau: number;
  /** Implied volatility, decimal. */
  iv: number;
  /** Risk-free rate, decimal. */
  r: number;
  /** Continuous dividend yield, decimal. */
  q: number;
  right: Right;
}

export interface BsOutput {
  price: number;
  delta: number;
  gamma: number;
  vega: number;
}

export function blackScholes(input: BsInput): BsOutput {
  const { spot: s, strike: k, tau, iv, r, q, right } = input;
  if (tau <= 0 || iv <= 0) {
    const intrinsic = right === "C" ? Math.max(0, s - k) : Math.max(0, k - s);
    return {
      price: intrinsic,
      delta: right === "C" ? (s > k ? 1 : 0) : s < k ? -1 : 0,
      gamma: 0,
      vega: 0,
    };
  }
  const sqrtTau = Math.sqrt(tau);
  const d1 = (Math.log(s / k) + (r - q + 0.5 * iv * iv) * tau) / (iv * sqrtTau);
  const d2 = d1 - iv * sqrtTau;
  const dfQ = Math.exp(-q * tau);
  const dfR = Math.exp(-r * tau);
  const price =
    right === "C"
      ? s * dfQ * normCdf(d1) - k * dfR * normCdf(d2)
      : k * dfR * normCdf(-d2) - s * dfQ * normCdf(-d1);
  const delta = right === "C" ? dfQ * normCdf(d1) : dfQ * (normCdf(d1) - 1);
  const gamma = (dfQ * normPdf(d1)) / (s * iv * sqrtTau);
  const vega = s * dfQ * normPdf(d1) * sqrtTau;
  return { price, delta, gamma, vega };
}

export function intrinsicValue(spot: number, strike: number, right: Right): number {
  return right === "C" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
}
