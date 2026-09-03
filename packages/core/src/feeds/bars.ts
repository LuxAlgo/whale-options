/*
  Underlying (equity) bar vocabulary shared by the adapters that serve stock
  bars and the API route that falls back to the spot tape when they cannot.
*/
import type { BarTimeframe } from "./types.js";

export const BAR_TIMEFRAME_MS: Record<BarTimeframe, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
};

/** Accepts "1m" | "5m" | "15m" | "1h" | "1d" and the bare-minute forms "1" | "5" | "15" | "60". */
export function parseBarTimeframe(value: string | null | undefined): BarTimeframe | null {
  switch ((value ?? "1m").trim().toLowerCase()) {
    case "1":
    case "1m":
    case "1min":
      return "1m";
    case "5":
    case "5m":
    case "5min":
      return "5m";
    case "15":
    case "15m":
    case "15min":
      return "15m";
    case "60":
    case "1h":
    case "60m":
      return "1h";
    case "1d":
    case "d":
    case "day":
      return "1d";
    default:
      return null;
  }
}
