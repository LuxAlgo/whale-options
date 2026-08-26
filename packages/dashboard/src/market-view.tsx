/*
  Market tab — the `whale market` renderers' visual sibling: the net-premium
  leaderboard for the whole tape, then per-underlying structure (OI deltas,
  max pain, IV rank) plus the FINRA short-volume cache. Every payload's
  note/caveat renders dim but always visible — the honesty fields are part of
  the data, not tooltip material.
*/
import { useState } from "react";
import { etDateTime, int, money, signedMoney } from "./format.js";
import type {
  IvRankResult,
  MaxPainResult,
  NetFlowReport,
  OiDeltasResult,
  ShortVolumeReport,
} from "./types.js";
import { useApi } from "./use-api.js";

export function MarketView({ chains }: { chains: string[] }) {
  const [picked, setPicked] = useState("");
  const active = picked !== "" && chains.includes(picked) ? picked : (chains[0] ?? "");

  return (
    <div className="space-y-5 pb-6">
      <NetFlowPanel />

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 pt-3">
          <h2 className="text-[10px] uppercase tracking-wide text-zinc-500">
            per-underlying structure
          </h2>
          {chains.length > 0 ? (
            <select
              value={active}
              onChange={(e) => setPicked(e.target.value)}
              aria-label="underlying"
              className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 focus:border-zinc-600 focus:outline-none"
            >
              {chains.map((symbol) => (
                <option key={symbol} value={symbol}>
                  {symbol}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-xs text-zinc-600">
              no chain snapshots yet — the picker fills once the engine snapshots
              universe.underlyings
            </span>
          )}
        </div>
        {active !== "" && (
          <>
            <OiDeltasPanel underlying={active} />
            <MaxPainPanel underlying={active} />
            <IvRankPanel underlying={active} />
            <ShortVolumePanel symbol={active} />
          </>
        )}
      </section>
    </div>
  );
}

/** Signed dollars, green/red/dim by sign — the leaderboard's color language. */
function SignedCell({ v }: { v: number }) {
  const cls = v > 0 ? "text-emerald-400" : v < 0 ? "text-red-400" : "text-zinc-500";
  return <span className={cls}>{signedMoney(v)}</span>;
}

function Note({ text }: { text: string }) {
  return <p className="max-w-4xl text-[10px] leading-4 text-zinc-500">note: {text}</p>;
}

const TH = "px-2 py-1.5 font-normal";
const PANEL = "overflow-x-auto rounded border border-zinc-800";
const TABLE = "w-full text-left text-xs tabular-nums";
const HEAD_ROW = "border-b border-zinc-800 text-[10px] uppercase tracking-wide text-zinc-500";

function NetFlowPanel() {
  const { data, error, loading } = useApi<{ netflow: NetFlowReport }>("/api/market/netflow?top=15");
  const report = data?.netflow ?? null;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-[10px] uppercase tracking-wide text-zinc-500">net premium flow</h2>
        {report && (
          <span className="text-[10px] text-zinc-600">
            {etDateTime(report.from)} → {etDateTime(report.to)} ET · {report.totals.underlyings}{" "}
            underlyings · {int(report.totals.events)} events
          </span>
        )}
        {loading && <span className="text-[10px] text-zinc-600">loading…</span>}
      </div>
      {error && <p className="text-xs text-amber-400">net flow query failed: {error}</p>}
      {report && (
        <>
          <div className={PANEL}>
            <table className={TABLE}>
              <thead>
                <tr className={HEAD_ROW}>
                  <th className={TH}>underlying</th>
                  <th className={`${TH} text-right`}>events</th>
                  <th className={`${TH} text-right`}>call net</th>
                  <th className={`${TH} text-right`}>put net</th>
                  <th className={`${TH} text-right`}>net premium</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.underlying} className="border-b border-zinc-900 last:border-0">
                    <td className="px-2 py-1 font-bold text-zinc-100">{r.underlying}</td>
                    <td className="px-2 py-1 text-right text-zinc-400">{int(r.events)}</td>
                    <td className="px-2 py-1 text-right">
                      <SignedCell v={r.callNet} />
                    </td>
                    <td className="px-2 py-1 text-right">
                      <SignedCell v={r.putNet} />
                    </td>
                    <td className="px-2 py-1 text-right font-bold">
                      <SignedCell v={r.netPremium} />
                    </td>
                  </tr>
                ))}
                {report.rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-zinc-600">
                      no events recorded in this window
                    </td>
                  </tr>
                )}
              </tbody>
              {report.rows.length > 0 && (
                <tfoot>
                  <tr className="border-t border-zinc-700 bg-zinc-900/50 font-bold">
                    <td className="px-2 py-1 text-zinc-300">TOTAL</td>
                    <td className="px-2 py-1 text-right text-zinc-300">
                      {int(report.totals.events)}
                    </td>
                    <td className="px-2 py-1 text-right">
                      <SignedCell v={report.totals.callNet} />
                    </td>
                    <td className="px-2 py-1 text-right">
                      <SignedCell v={report.totals.putNet} />
                    </td>
                    <td className="px-2 py-1 text-right">
                      <SignedCell v={report.totals.netPremium} />
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <Note text={report.note} />
        </>
      )}
    </section>
  );
}

function OiDeltasPanel({ underlying }: { underlying: string }) {
  const { data, error } = useApi<{ oi: OiDeltasResult }>(
    `/api/market/oi/${encodeURIComponent(underlying)}?top=20`,
  );
  const oi = data?.oi ?? null;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-3">
        <h3 className="text-[10px] uppercase tracking-wide text-zinc-500">open-interest deltas</h3>
        {oi?.fromDate && (
          <span className="text-[10px] text-zinc-600">
            {oi.fromDate} → {oi.toDate} · {oi.sessionsAvailable} sessions recorded
          </span>
        )}
      </div>
      {error && <p className="text-xs text-amber-400">OI query failed: {error}</p>}
      {oi?.note !== null && oi !== null && (
        <p className="max-w-4xl rounded border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-amber-200/80">
          {oi.note}
        </p>
      )}
      {oi !== null && oi.contracts.length > 0 && (
        <div className={PANEL}>
          <table className={TABLE}>
            <thead>
              <tr className={HEAD_ROW}>
                <th className={TH}>contract</th>
                <th className={`${TH} text-right`}>prev → now</th>
                <th className={`${TH} text-right`}>Δ</th>
                <th className={`${TH} text-right`}>Δ%</th>
                <th className={TH} />
              </tr>
            </thead>
            <tbody>
              {oi.contracts.map((c) => (
                <tr key={c.contract} className="border-b border-zinc-900 last:border-0">
                  <td className="px-2 py-1 text-zinc-300">{c.contract}</td>
                  <td className="px-2 py-1 text-right text-zinc-400">
                    {c.prevOi === null ? "∅" : int(c.prevOi)} → {int(c.currOi)}
                  </td>
                  <td
                    className={`px-2 py-1 text-right ${
                      c.deltaOi > 0
                        ? "text-emerald-400"
                        : c.deltaOi < 0
                          ? "text-red-400"
                          : "text-zinc-500"
                    }`}
                  >
                    {c.deltaOi > 0 ? "+" : ""}
                    {int(c.deltaOi)}
                  </td>
                  <td className="px-2 py-1 text-right text-zinc-400">
                    {c.deltaPct === null ? "n/a" : `${c.deltaPct > 0 ? "+" : ""}${c.deltaPct}%`}
                  </td>
                  <td className="px-2 py-1">
                    {c.newContract && (
                      <span className="rounded border border-yellow-400/30 bg-yellow-400/10 px-1 text-[10px] font-bold text-yellow-400">
                        NEW
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function MaxPainPanel({ underlying }: { underlying: string }) {
  const { data, error } = useApi<{ maxpain: MaxPainResult }>(
    `/api/market/maxpain/${encodeURIComponent(underlying)}`,
  );
  const mp = data?.maxpain ?? null;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-3">
        <h3 className="text-[10px] uppercase tracking-wide text-zinc-500">max pain per expiry</h3>
        {mp && mp.source !== null && (
          <span className="text-[10px] text-zinc-600">
            {mp.spot !== null && <>spot ${mp.spot.toFixed(2)} · </>}
            source{" "}
            {mp.source === "chain-snapshot"
              ? `chain snapshot ${etDateTime(mp.asOfTs ?? 0)} ET`
              : `contract_daily ${mp.sessionDate}`}
          </span>
        )}
      </div>
      {error && <p className="text-xs text-amber-400">max pain query failed: {error}</p>}
      {mp && mp.expiries.length > 0 && (
        <div className={PANEL}>
          <table className={TABLE}>
            <thead>
              <tr className={HEAD_ROW}>
                <th className={TH}>expiry</th>
                <th className={`${TH} text-right`}>max-pain strike</th>
                <th className={`${TH} text-right`}>payout at strike</th>
                <th className={`${TH} text-right`}>call OI</th>
                <th className={`${TH} text-right`}>put OI</th>
                <th className={`${TH} text-right`}>strikes</th>
              </tr>
            </thead>
            <tbody>
              {mp.expiries.map((e) => (
                <tr key={e.expiry} className="border-b border-zinc-900 last:border-0">
                  <td className="px-2 py-1 text-zinc-300">{e.expiry}</td>
                  <td className="px-2 py-1 text-right font-bold text-zinc-100">
                    {e.maxPainStrike}
                  </td>
                  <td className="px-2 py-1 text-right text-zinc-300">
                    {money(e.totalPayoutAtStrike)}
                  </td>
                  <td className="px-2 py-1 text-right text-zinc-400">{int(e.callOi)}</td>
                  <td className="px-2 py-1 text-right text-zinc-400">{int(e.putOi)}</td>
                  <td className="px-2 py-1 text-right text-zinc-500">{e.strikesEvaluated}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {mp && <Note text={mp.note} />}
    </section>
  );
}

function IvRankPanel({ underlying }: { underlying: string }) {
  const { data, error } = useApi<{ ivrank: IvRankResult }>(
    `/api/market/ivrank/${encodeURIComponent(underlying)}`,
  );
  const iv = data?.ivrank ?? null;

  return (
    <section className="space-y-1.5">
      <h3 className="text-[10px] uppercase tracking-wide text-zinc-500">IV rank</h3>
      {error && <p className="text-xs text-amber-400">IV rank query failed: {error}</p>}
      {iv &&
        (iv.currentIv === null ? (
          <p className="max-w-4xl text-xs text-amber-200/80">{iv.note}</p>
        ) : (
          <>
            <p className="text-xs text-zinc-300">
              ATM IV <span className="font-bold text-zinc-100">{iv.currentIv}</span> · rank{" "}
              <span className="font-bold text-zinc-100">{iv.ivRank ?? "∅"}</span> · percentile{" "}
              <span className="text-zinc-100">{iv.ivPercentile}</span> · min {iv.minIv} / max{" "}
              {iv.maxIv} ·{" "}
              <span className="text-zinc-500">
                history {iv.historyDays} session{iv.historyDays === 1 ? "" : "s"} ({iv.firstDate} →{" "}
                {iv.lastDate})
              </span>
            </p>
            <Note text={iv.note} />
          </>
        ))}
    </section>
  );
}

function ShortVolumePanel({ symbol }: { symbol: string }) {
  const { data, error } = useApi<{ shortVolume: ShortVolumeReport }>(
    `/api/context/short-volume/${encodeURIComponent(symbol)}?days=20`,
  );
  const sv = data?.shortVolume ?? null;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-3">
        <h3 className="text-[10px] uppercase tracking-wide text-zinc-500">
          short volume (FINRA, end-of-day)
        </h3>
        {sv && sv.avgShortRatio !== null && (
          <span className="text-[10px] text-zinc-600">
            avg short ratio {(sv.avgShortRatio * 100).toFixed(1)}% over {sv.days.length} cached day
            {sv.days.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {error && <p className="text-xs text-amber-400">short-volume query failed: {error}</p>}
      {sv && sv.days.length === 0 && (
        <p className="text-xs text-zinc-600">
          no cached short-volume rows for {sv.symbol}; fill the cache with{" "}
          <code className="bg-zinc-900 px-1">whale context short-volume {sv.symbol} --sync</code>
        </p>
      )}
      {sv && sv.days.length > 0 && (
        <div className={PANEL}>
          <table className={TABLE}>
            <thead>
              <tr className={HEAD_ROW}>
                <th className={TH}>session</th>
                <th className={`${TH} text-right`}>short</th>
                <th className={`${TH} text-right`}>exempt</th>
                <th className={`${TH} text-right`}>total</th>
                <th className={`${TH} text-right`}>short ratio</th>
              </tr>
            </thead>
            <tbody>
              {sv.days.map((d) => (
                <tr key={d.sessionDate} className="border-b border-zinc-900 last:border-0">
                  <td className="px-2 py-1 text-zinc-400">{d.sessionDate}</td>
                  <td className="px-2 py-1 text-right text-zinc-300">{int(d.shortVolume)}</td>
                  <td className="px-2 py-1 text-right text-zinc-500">{int(d.shortExemptVolume)}</td>
                  <td className="px-2 py-1 text-right text-zinc-300">{int(d.totalVolume)}</td>
                  <td className="px-2 py-1 text-right text-zinc-200">
                    {d.shortRatio === null ? "n/a" : `${(d.shortRatio * 100).toFixed(1)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sv && <Note text={sv.note} />}
    </section>
  );
}
