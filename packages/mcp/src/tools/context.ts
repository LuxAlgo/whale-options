/*
  Context tools: FINRA daily short-sale volume. Cache-read only — this server
  never touches the network; the CLI's `whale context short-volume --sync` is
  the only thing that fetches from FINRA, and it stores only the user's own
  universe in the user's own flight recorder. Nothing is redistributed.
*/

import { type FlightRecorder, shortVolumeReport, type WhaleConfig } from "@luxalgo/whale-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function json(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

export function registerContextTools(
  server: McpServer,
  deps: { store: FlightRecorder; config: WhaleConfig },
): void {
  const { store, config } = deps;

  server.registerTool(
    "whale_short_volume",
    {
      title: "FINRA daily short-sale volume (EOD context)",
      description:
        "Cached FINRA daily short-sale volume for one symbol — off-exchange trades reported to FINRA facilities, published END-OF-DAY. Be precise about what this is: it is NOT real-time dark-pool data (nothing self-serve is — this dataset is the honest end-of-day substitute), and short volume is NOT short interest (a flow measure for one day, not an outstanding-position count; market-maker hedging and liquidity provision print short structurally, so ratios around half of daily volume are the mechanical norm, not evidence of directional bets). Params: symbol ('NVDA'); days (weekdays of history, default 20, max 60). Returns {symbol, days: [{sessionDate, shortVolume, shortExemptVolume, totalVolume, shortRatio}], avg_short_ratio, note} — shortRatio is shortVolume/totalVolume for that session, avg_short_ratio the mean over the returned sessions, and `note` is the dataset's standing caveat: relay it (or a faithful paraphrase) whenever you summarize these numbers, every time — the ratio invites exactly the misreadings the note preempts. Interpretation discipline: compare a symbol against its OWN recent ratios, never against a fixed threshold, and treat any single-day reading as context for the options tape, not a signal. This tool reads the local cache only — no network. An empty `days` means the cache has nothing for the symbol: syncing happens via the CLI (`whale context short-volume <symbol> --sync`), which downloads FINRA's public daily files directly to this user's flight recorder; tell the user to run it rather than retrying here.",
      inputSchema: {
        symbol: z.string().min(1).describe("Symbol, e.g. 'NVDA'"),
        days: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .describe("Weekdays of history to return (default 20)"),
      },
    },
    async ({ symbol, days }) => {
      const report = shortVolumeReport(store, symbol, days ?? 20);
      const universe = config.universe.underlyings;
      return json({
        symbol: report.symbol,
        days: report.days,
        avg_short_ratio: report.avgShortRatio,
        note: report.note,
        ...(report.days.length === 0
          ? {
              hint:
                `no cached rows for ${report.symbol} — run \`whale context short-volume ${report.symbol} --sync\` ` +
                `(syncs the configured universe${universe.length > 0 ? `: ${universe.join(", ")}` : ""} from FINRA's public daily files; this server never fetches)`,
            }
          : {}),
      });
    },
  );
}
