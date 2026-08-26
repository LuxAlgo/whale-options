/*
  Audit tab — `whale audit` on screen: calibration of recorded whale scores
  against forward moves of the underlying, over the user's own tape. A
  measuring instrument, not a performance claim: small-n buckets are dimmed
  and labeled noise, the base rate prints beside every table, and the
  engine's caveats block always renders — the synthetic-tape caveat as a loud
  banner, never a footnote.
*/
import { useState } from "react";
import { etDateTime, int } from "./format.js";
import type { CalibrationBucket, CalibrationReport } from "./types.js";
import { useApi } from "./use-api.js";

const HORIZONS = ["15m", "1h", "eod", "1d", "5d"] as const;

export function AuditView() {
  const [horizon, setHorizon] = useState<(typeof HORIZONS)[number]>("1h");
  const [underlying, setUnderlying] = useState("");
  const [excludeColdStart, setExcludeColdStart] = useState(false);

  const params = new URLSearchParams({ horizon });
  const ticker = underlying.trim().toUpperCase();
  if (ticker) params.set("underlying", ticker);
  if (excludeColdStart) params.set("excludeColdStart", "true");

  const { data, error, loading } = useApi<{ audit: CalibrationReport }>(
    `/api/audit?${params.toString()}`,
    250,
  );
  const report = data?.audit ?? null;
  const synthetic = report?.caveats.find((c) => c.startsWith("SYNTHETIC TAPE")) ?? null;

  return (
    <div className="space-y-4 pb-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">horizon</span>
        <div className="flex overflow-hidden rounded border border-zinc-800">
          {HORIZONS.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => setHorizon(h)}
              aria-pressed={horizon === h}
              className={`px-2.5 py-1 text-xs ${
                horizon === h
                  ? "bg-zinc-200 font-bold text-zinc-950"
                  : "bg-zinc-900 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {h}
            </button>
          ))}
        </div>
        <input
          value={underlying}
          onChange={(e) => setUnderlying(e.target.value)}
          placeholder="underlying (all)"
          aria-label="restrict to one underlying"
          className="w-32 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs uppercase text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
        />
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={excludeColdStart}
            onChange={(e) => setExcludeColdStart(e.target.checked)}
            className="accent-zinc-400"
          />
          exclude cold-start
        </label>
        {loading && <span className="text-[10px] text-zinc-600">calibrating…</span>}
      </div>

      {error && <p className="text-xs text-amber-400">audit failed: {error}</p>}

      {report && (
        <>
          {synthetic && (
            <p className="rounded border-2 border-amber-500/70 bg-amber-500/15 px-3 py-2 text-xs font-bold leading-5 text-amber-300">
              {synthetic}
            </p>
          )}

          <p className="text-[10px] text-zinc-500">
            window {etDateTime(report.window.from)} → {etDateTime(report.window.to)} ET ·{" "}
            {int(report.eventsConsidered)} events considered, {int(report.eventsWithOutcome)} with
            an outcome · excluded: {int(report.excluded.mid)} mid, {int(report.excluded.unknown)}{" "}
            unknown side, {int(report.excluded.noPriceData)} no price data
          </p>

          <BucketTable
            title="by score bucket"
            rows={report.buckets}
            baseAligned={report.baseRate.alignedPct}
          />

          <p className="text-xs text-zinc-500">
            base rate (all events with an outcome, same window): aligned{" "}
            <span className="text-zinc-300">{pct1(report.baseRate.alignedPct)}</span>, median fwd{" "}
            <span className="text-zinc-300">{fwd(report.baseRate.medianFwdReturnPct)}</span>; coin
            flip is 50%
          </p>

          <div className="grid gap-4 lg:grid-cols-2">
            <BucketTable
              title="by kind"
              rows={report.byKind}
              baseAligned={report.baseRate.alignedPct}
            />
            <BucketTable
              title="by side"
              rows={report.bySide}
              baseAligned={report.baseRate.alignedPct}
            />
          </div>

          <section className="max-w-5xl rounded border border-amber-500/20 bg-amber-500/5 px-3 py-2">
            <h3 className="text-[10px] font-bold uppercase tracking-wide text-amber-400/90">
              caveats — read before quoting any number
            </h3>
            <ul className="mt-1 space-y-1">
              {report.caveats.map((caveat) => (
                <li
                  key={caveat}
                  className={`text-[11px] leading-4 ${
                    caveat.startsWith("SYNTHETIC TAPE")
                      ? "font-bold text-amber-300"
                      : "text-amber-200/70"
                  }`}
                >
                  · {caveat}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function pct1(v: number | null): string {
  return v === null ? "n/a" : `${v.toFixed(1)}%`;
}

function fwd(v: number | null): string {
  if (v === null) return "n/a";
  return `${v > 0 ? "+" : ""}${v.toFixed(3)}%`;
}

function BucketTable({
  title,
  rows,
  baseAligned,
}: {
  title: string;
  rows: CalibrationBucket[];
  baseAligned: number | null;
}) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[10px] uppercase tracking-wide text-zinc-500">{title}</h3>
      <div className="overflow-x-auto rounded border border-zinc-800">
        <table className="w-full text-left text-xs tabular-nums">
          <thead>
            <tr className="border-b border-zinc-800 text-[10px] uppercase tracking-wide text-zinc-500">
              <th className="px-2 py-1.5 font-normal">bucket</th>
              <th className="px-2 py-1.5 text-right font-normal">n</th>
              <th className="px-2 py-1.5 text-right font-normal">median fwd</th>
              <th className="px-2 py-1.5 text-right font-normal">mean fwd</th>
              <th className="px-2 py-1.5 text-right font-normal">aligned</th>
              <th className="px-2 py-1.5 text-right font-normal">vs base</th>
              <th className="px-2 py-1.5 font-normal" />
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => {
              const delta =
                b.alignedPct === null || baseAligned === null ? null : b.alignedPct - baseAligned;
              const tone = b.smallN ? "text-zinc-600" : "text-zinc-300";
              return (
                <tr key={b.label} className="border-b border-zinc-900 last:border-0">
                  <td className={`px-2 py-1 ${b.smallN ? "text-zinc-600" : "text-zinc-100"}`}>
                    {b.label}
                  </td>
                  <td className={`px-2 py-1 text-right ${tone}`}>{int(b.n)}</td>
                  <td className={`px-2 py-1 text-right ${tone}`}>{fwd(b.medianFwdReturnPct)}</td>
                  <td className={`px-2 py-1 text-right ${tone}`}>{fwd(b.meanFwdReturnPct)}</td>
                  <td className={`px-2 py-1 text-right ${tone}`}>{pct1(b.alignedPct)}</td>
                  <td className="px-2 py-1 text-right">
                    {delta === null ? (
                      <span className="text-zinc-600">n/a</span>
                    ) : (
                      <span
                        className={`rounded border px-1 text-[10px] ${
                          b.smallN
                            ? "border-zinc-800 text-zinc-600"
                            : delta >= 0
                              ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-400"
                              : "border-red-400/30 bg-red-400/10 text-red-400"
                        }`}
                      >
                        {delta >= 0 ? "+" : ""}
                        {delta.toFixed(1)}pt
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1">
                    {b.smallN && (
                      <span className="text-[10px] text-yellow-400/80">n&lt;30, noise</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-4 text-center text-zinc-600">
                  no events with an outcome
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
