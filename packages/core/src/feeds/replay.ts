/*
  Replay feed + tape writer. Tapes are NDJSON files of OptionTradeTicks —
  fully enriched (NBBO/spot/OI ride on the tick), so replay needs zero
  external lookups and same tape + same config ⇒ byte-identical events.
  Original `seq` values are preserved so event ids survive replay even when
  replaying a window out of a longer recording.
*/

import type { WriteStream } from "node:fs";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { ChainSnapshot, Nbbo, NormalizedCondition, OptionTradeTick } from "../types.js";
import type { FeedAdapter, FeedCapabilities, RawOptionTrade, TradeFilter } from "./types.js";

/** A tape row is an OptionTradeTick; RawOptionTrade plus the preserved seq. */
export interface TapeRow extends RawOptionTrade {
  seq?: number;
  underlying?: string;
}

export class ReplayFeed implements FeedAdapter {
  readonly id = "replay" as const;
  private lastNbbo = new Map<string, Nbbo>();

  constructor(private readonly tapePath: string) {}

  capabilities(): FeedCapabilities {
    return { realtime: false, greeksProvided: false, nbbo: true, conditions: true };
  }

  normalizeCondition(code: string): NormalizedCondition {
    const known: NormalizedCondition[] = [
      "regular",
      "iso",
      "auto",
      "spread-leg",
      "spread-leg-equity",
      "auction",
      "cross",
      "floor",
      "cancel",
      "late",
      "out-of-sequence",
      "reopening",
      "unknown",
    ];
    return (known as string[]).includes(code) ? (code as NormalizedCondition) : "unknown";
  }

  async *subscribeOptionTrades(
    filter: TradeFilter,
    signal?: AbortSignal,
  ): AsyncIterable<RawOptionTrade> {
    const rl = createInterface({
      input: createReadStream(this.tapePath, { encoding: "utf8" }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    try {
      for await (const line of rl) {
        if (signal?.aborted) return;
        const trimmed = line.trim();
        if (!trimmed) continue;
        let row: TapeRow;
        try {
          row = JSON.parse(trimmed) as TapeRow;
        } catch {
          continue; // tolerate a torn final line from an interrupted recording
        }
        if (
          filter.underlyings?.length &&
          row.underlying &&
          !filter.underlyings.includes(row.underlying)
        ) {
          continue;
        }
        if (row.nbbo) this.lastNbbo.set(row.contract, row.nbbo);
        yield row;
      }
    } finally {
      rl.close();
    }
  }

  async getNbbo(contract: string): Promise<Nbbo | null> {
    return this.lastNbbo.get(contract) ?? null;
  }

  async getChainSnapshot(_underlying: string): Promise<ChainSnapshot | null> {
    return null; // tapes carry per-tick OI; there is no chain to snapshot
  }
}

/** Append-only NDJSON tape writer used by `whale run --record`. */
export class TapeWriter {
  private stream: WriteStream;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.stream = createWriteStream(path, { flags: "a" });
  }

  write(tick: OptionTradeTick): void {
    this.stream.write(`${JSON.stringify(tick)}\n`);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}
