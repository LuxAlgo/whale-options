/*
  IV rank and percentile over the recorded ATM-IV history. The convention
  quoted by vol tools assumes a 52-week window; the flight recorder only
  holds the sessions it has actually seen, so the result always states its
  window (`historyDays`) and carries an explicit note when that window is
  shorter than 60 sessions. Rank = (current − min) / (max − min); percentile
  = fraction of recorded sessions with ATM IV below the current one. Both
  describe where today's IV sits inside recorded history — nothing more.
*/

import type { FlightRecorder } from "../store/types.js";
import { round } from "../util/session.js";

export interface IvRankResult {
  underlying: string;
  /** Latest recorded ATM IV (decimal, e.g. 0.42); null when no IV history exists. */
  currentIv: number | null;
  minIv: number | null;
  maxIv: number | null;
  /** (current − min) / (max − min) over recorded history; null when the range is degenerate. */
  ivRank: number | null;
  /** Fraction of recorded sessions with ATM IV strictly below current. */
  ivPercentile: number | null;
  /** Sessions with a recorded ATM IV — the actual window behind rank/percentile. */
  historyDays: number;
  firstDate: string | null;
  lastDate: string | null;
  note: string;
}

export function ivRank(store: FlightRecorder, underlying: string): IvRankResult {
  const symbol = underlying.toUpperCase();
  const rows = store
    .getUnderlyingDaily(symbol)
    .filter((r): r is typeof r & { atmIv: number } => r.atmIv !== null);

  if (rows.length === 0) {
    return {
      underlying: symbol,
      currentIv: null,
      minIv: null,
      maxIv: null,
      ivRank: null,
      ivPercentile: null,
      historyDays: 0,
      firstDate: null,
      lastDate: null,
      note:
        `no ATM IV history recorded for ${symbol}; ` +
        "run the engine across sessions or `whale backfill`",
    };
  }

  const ivs = rows.map((r) => r.atmIv);
  const current = ivs.at(-1)!;
  const min = Math.min(...ivs);
  const max = Math.max(...ivs);
  const historyDays = rows.length;
  const rank = max > min ? round((current - min) / (max - min), 4) : null;
  const percentile = round(ivs.filter((iv) => iv < current).length / historyDays, 4);

  const windowNote =
    historyDays < 60
      ? `rank over ${historyDays} session${historyDays === 1 ? "" : "s"}, not a 52-week window`
      : `rank over ${historyDays} recorded sessions`;
  const note =
    rank === null
      ? `${windowNote}; recorded min and max IV are equal, so rank is undefined`
      : windowNote;

  return {
    underlying: symbol,
    currentIv: round(current, 4),
    minIv: round(min, 4),
    maxIv: round(max, 4),
    ivRank: rank,
    ivPercentile: percentile,
    historyDays,
    firstDate: rows[0]!.sessionDate,
    lastDate: rows.at(-1)!.sessionDate,
    note,
  };
}
