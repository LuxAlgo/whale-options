/*
  GEX view: the per-strike net gamma exposure ladder (hand-rolled SVG — no
  chart libraries, on purpose) next to the strike-by-expiry heatmap, both
  re-priced at the latest live spot every couple of seconds while the tab is
  visible (the chain is a snapshot; only the spot moves, and the pricing line
  says exactly that). The engine's convention note shows verbatim: the sign
  convention is an assumption about dealer positioning, and the UI must say
  so rather than dress it up as data.
*/
import { Fragment, useState } from "react";
import { etDateTime, etTime, int, signedMoney } from "./format.js";
import { useLiveSpot } from "./live-socket.js";
import type { GexHeatmap, GexLadder } from "./types.js";
import { useLiveGex } from "./use-chart-data.js";

export function GexView({ chains, active: visible }: { chains: string[]; active: boolean }) {
  const [picked, setPicked] = useState("");
  const active = picked !== "" && chains.includes(picked) ? picked : (chains[0] ?? "");
  const liveSpot = useLiveSpot(visible && active !== "" ? active : null);
  const { ladder, heatmap, error, loading } = useLiveGex(
    active === "" ? null : active,
    liveSpot.spot,
    visible,
    true,
  );

  if (chains.length === 0) {
    return (
      <p className="max-w-xl text-xs leading-5 text-zinc-500">
        No chain snapshots yet; GEX needs one. The engine snapshots chains for every underlying in{" "}
        <code className="bg-zinc-900 px-1">universe.underlyings</code> (the synthetic feed populates
        its built-in symbols automatically a few seconds after start).
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
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
        {ladder && (
          <p className="text-xs text-zinc-400">
            spot <span className="text-sky-400">${ladder.spot.toFixed(2)}</span> · total net GEX{" "}
            <span className={ladder.totalGex >= 0 ? "text-emerald-400" : "text-red-400"}>
              {signedMoney(ladder.totalGex)}
            </span>{" "}
            <span className="text-zinc-600">per 1% move</span> · zero-gamma{" "}
            {ladder.zeroGamma ? (
              <span className="text-amber-400" title={ladder.zeroGamma.method}>
                {ladder.zeroGamma.level.toFixed(2)}
              </span>
            ) : (
              <span className="text-zinc-600">no sign change in scan range</span>
            )}{" "}
            · {ladder.expiriesIncluded.length} expiries · chain {etDateTime(ladder.ts)} ET
          </p>
        )}
        {loading && <span className="text-[10px] text-zinc-600">loading…</span>}
      </div>

      {ladder && (
        <p className="text-[10px] text-zinc-500">
          pricing: {ladder.pricing.note}
          {ladder.pricing.spotSource === "override" && ladder.pricing.repricedTs !== null
            ? ` · re-priced live every ~2s while this tab is visible (last ${etTime(ladder.pricing.repricedTs)} ET)`
            : liveSpot.spot === null
              ? " · live re-pricing starts once the stream reports a spot for this name"
              : ""}
        </p>
      )}

      {error && <p className="text-xs text-amber-400">{error}</p>}

      {ladder && (
        <>
          <div className="flex flex-wrap items-center gap-4 text-[10px] text-zinc-500">
            <span>
              <span className="mr-1 inline-block h-2 w-3 rounded-sm bg-emerald-500/80 align-middle" />
              net GEX &gt; 0
            </span>
            <span>
              <span className="mr-1 inline-block h-2 w-3 rounded-sm bg-red-500/80 align-middle" />
              net GEX &lt; 0
            </span>
            <span className="text-sky-400">╌ spot</span>
            <span className="text-amber-400">╌ zero-gamma</span>
            {ladder.skippedContracts > 0 && (
              <span>
                {int(ladder.skippedContracts)} contracts skipped (no OI/IV/greeks derivable)
              </span>
            )}
          </div>
          <div className="max-w-4xl rounded border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-amber-200/80">
            <span className="mr-1 text-[10px] font-bold uppercase tracking-wide text-amber-400/90">
              assumption
            </span>
            convention "{ladder.convention}": {ladder.conventionNote}
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            <div className="overflow-x-auto rounded border border-zinc-800 bg-zinc-950 p-2">
              <LadderSvg ladder={ladder} />
            </div>
            {heatmap && <HeatmapGrid heatmap={heatmap} />}
          </div>
          {ladder.zeroGamma && (
            <p className="text-[10px] text-zinc-600">
              zero-gamma method: {ladder.zeroGamma.method}
            </p>
          )}
          {heatmap && (
            <p className="max-w-5xl text-[10px] leading-4 text-zinc-500">heatmap: {heatmap.note}</p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Strike × expiry net GEX grid: diverging green/red scale on |value| against
 * the grid's own maximum, the value printed in every cell, per-expiry totals
 * in the footer, the all-expiry ladder as the last column, the spot row
 * highlighted, and the zero-gamma level marked between the rows it falls in.
 */
function HeatmapGrid({ heatmap }: { heatmap: GexHeatmap }) {
  const maxAbs = Math.max(1, ...heatmap.cells.flat().map((v) => Math.abs(v)));
  const cellStyle = (v: number) => {
    const t = Math.min(1, Math.abs(v) / maxAbs);
    const alpha = 0.08 + 0.72 * Math.sqrt(t);
    return {
      backgroundColor: v >= 0 ? `rgba(16,185,129,${alpha})` : `rgba(239,68,68,${alpha})`,
      color: t > 0.45 ? "#fafafa" : v >= 0 ? "#a7f3d0" : "#fecaca",
    };
  };
  // Rows run high strike → low strike, like the ladder; zero-gamma sits between rows.
  const order = heatmap.strikes.map((_, i) => i).reverse();
  const zero = heatmap.zeroGamma?.level ?? null;
  const zeroAfterRow = (rowIdx: number): boolean => {
    if (zero === null) return false;
    const here = heatmap.strikes[rowIdx];
    const nextIdx = rowIdx - 1;
    const below = heatmap.strikes[nextIdx];
    if (here === undefined) return false;
    if (below === undefined) return zero < here && rowIdx === 0;
    return zero < here && zero >= below;
  };
  return (
    <div className="overflow-x-auto rounded border border-zinc-800 bg-zinc-950">
      <table className="w-full text-right text-[11px] tabular-nums">
        <thead>
          <tr className="border-b border-zinc-800 text-[10px] uppercase tracking-wide text-zinc-500">
            <th className="px-2 py-1.5 text-left font-normal">strike</th>
            {heatmap.expiries.map((e) => (
              <th key={e} className="px-2 py-1.5 font-normal">
                {e.slice(5)}
              </th>
            ))}
            <th className="border-l border-zinc-800 px-2 py-1.5 font-normal text-zinc-300">all</th>
          </tr>
        </thead>
        <tbody>
          {order.map((i) => {
            const strike = heatmap.strikes[i] ?? 0;
            const isSpot = heatmap.spotRowIndex === i;
            return (
              <Fragment key={strike}>
                <tr
                  className={isSpot ? "outline outline-1 -outline-offset-1 outline-sky-400/70" : ""}
                  title={isSpot ? `spot ${heatmap.spot.toFixed(2)} sits at this strike` : undefined}
                >
                  <td
                    className={`px-2 py-0.5 text-left ${isSpot ? "text-sky-300" : "text-zinc-400"}`}
                  >
                    {strike}
                    {isSpot ? " ◂ spot" : ""}
                  </td>
                  {(heatmap.cells[i] ?? []).map((v, j) => (
                    <td key={heatmap.expiries[j]} className="px-2 py-0.5" style={cellStyle(v)}>
                      {signedMoney(v)}
                    </td>
                  ))}
                  <td
                    className={`border-l border-zinc-800 px-2 py-0.5 font-bold ${
                      (heatmap.strikeTotals[i] ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"
                    }`}
                  >
                    {signedMoney(heatmap.strikeTotals[i] ?? 0)}
                  </td>
                </tr>
                {zeroAfterRow(i) && zero !== null && (
                  <tr>
                    <td
                      colSpan={heatmap.expiries.length + 2}
                      className="border-t border-dashed border-amber-400/70 px-2 py-0 text-left text-[9px] leading-3 text-amber-400"
                    >
                      zero-gamma {zero.toFixed(2)}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t border-zinc-700 bg-zinc-900/50 font-bold">
            <td className="px-2 py-1 text-left text-zinc-300">TOTAL</td>
            {heatmap.expiryTotals.map((v, j) => (
              <td
                key={heatmap.expiries[j]}
                className={`px-2 py-1 ${v >= 0 ? "text-emerald-400" : "text-red-400"}`}
                title="this expiry's whole ladder, including strikes not shown"
              >
                {signedMoney(v)}
              </td>
            ))}
            <td
              className={`border-l border-zinc-800 px-2 py-1 ${
                heatmap.totalGex >= 0 ? "text-emerald-400" : "text-red-400"
              }`}
            >
              {signedMoney(heatmap.totalGex)}
            </td>
          </tr>
        </tfoot>
      </table>
      <p className="px-2 py-1 text-[10px] text-zinc-600">
        net GEX per 1% move, strike × expiry · {heatmap.strikes.length} strikes nearest spot shown
        {heatmap.strikesOmitted > 0 ? `, ${int(heatmap.strikesOmitted)} omitted` : ""} · "all" is
        the ladder row · totals are each expiry's whole ladder
      </p>
    </div>
  );
}

function LadderSvg({ ladder }: { ladder: GexLadder }) {
  // Highest strike at the top, like a price ladder.
  const rows = [...ladder.perStrike].sort((a, b) => b.strike - a.strike);
  const n = rows.length;
  if (n === 0) return <p className="text-xs text-zinc-600">no strikes with usable gamma</p>;

  const rowH = n > 60 ? 12 : n > 32 ? 16 : 20;
  const barH = Math.max(5, rowH - 7);
  const showValues = rowH >= 16;
  const top = 14;
  const bottom = 10;
  const labelW = 64;
  const valuePad = showValues ? 88 : 24;
  const width = 860;
  const plotW = width - labelW - 12;
  const height = top + n * rowH + bottom;
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.netGex)));
  const x0 = labelW + plotW / 2;
  const scale = (plotW / 2 - valuePad) / maxAbs;
  const xOf = (v: number) => x0 + v * scale;
  const yOfIndex = (i: number) => top + i * rowH + rowH / 2;

  // Prices (spot, zero-gamma) sit between strikes: interpolate on the axis.
  const yOfPrice = (price: number): number => {
    const first = rows[0];
    const last = rows[n - 1];
    if (!first || !last) return top;
    if (price >= first.strike) return top + 2;
    if (price <= last.strike) return height - bottom - 2;
    for (let i = 0; i < n - 1; i++) {
      const hi = rows[i];
      const lo = rows[i + 1];
      if (!hi || !lo) continue;
      if (price <= hi.strike && price >= lo.strike) {
        const f = (hi.strike - price) / (hi.strike - lo.strike || 1);
        return yOfIndex(i) + f * (yOfIndex(i + 1) - yOfIndex(i));
      }
    }
    return top;
  };

  const ySpot = yOfPrice(ladder.spot);
  const yZero = ladder.zeroGamma ? yOfPrice(ladder.zeroGamma.level) : null;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full min-w-[640px]"
      role="img"
      aria-label={`net gamma exposure per strike for ${ladder.underlying}`}
    >
      {/* zero axis */}
      <line
        x1={x0}
        x2={x0}
        y1={top - 4}
        y2={height - bottom}
        className="stroke-zinc-700"
        strokeWidth={1}
      />
      <text x={x0} y={top - 6} textAnchor="middle" fontSize={9} className="fill-zinc-600">
        0
      </text>

      {/* reference lines sit under the bars so labels stay legible */}
      <line
        x1={labelW}
        x2={width - 4}
        y1={ySpot}
        y2={ySpot}
        className="stroke-sky-400"
        strokeWidth={1}
        strokeDasharray="5 4"
      />
      {yZero !== null && (
        <line
          x1={labelW}
          x2={width - 4}
          y1={yZero}
          y2={yZero}
          className="stroke-amber-400"
          strokeWidth={1}
          strokeDasharray="2 4"
        />
      )}

      {rows.map((row, i) => {
        const y = yOfIndex(i);
        const xEnd = xOf(row.netGex);
        const positive = row.netGex >= 0;
        return (
          <g key={row.strike}>
            <title>
              {`strike ${row.strike} · net ${signedMoney(row.netGex)} · calls ${signedMoney(row.callGex)} · puts ${signedMoney(row.putGex)} · OI ${int(row.callOi)}C / ${int(row.putOi)}P`}
            </title>
            <text x={labelW - 8} y={y + 3} textAnchor="end" fontSize={10} className="fill-zinc-400">
              {row.strike}
            </text>
            <rect
              x={Math.min(x0, xEnd)}
              y={y - barH / 2}
              width={Math.max(Math.abs(xEnd - x0), 0.75)}
              height={barH}
              rx={1}
              className={positive ? "fill-emerald-500/80" : "fill-red-500/80"}
            />
            {showValues && (
              <text
                x={positive ? xEnd + 5 : xEnd - 5}
                y={y + 3}
                textAnchor={positive ? "start" : "end"}
                fontSize={9}
                className="fill-zinc-500"
              >
                {signedMoney(row.netGex)}
              </text>
            )}
          </g>
        );
      })}

      <text x={width - 6} y={ySpot - 4} textAnchor="end" fontSize={10} className="fill-sky-400">
        spot {ladder.spot.toFixed(2)}
      </text>
      {yZero !== null && ladder.zeroGamma && (
        <text
          x={width - 6}
          y={yZero + 12}
          textAnchor="end"
          fontSize={10}
          className="fill-amber-400"
        >
          zero-gamma {ladder.zeroGamma.level.toFixed(2)}
        </text>
      )}
    </svg>
  );
}
