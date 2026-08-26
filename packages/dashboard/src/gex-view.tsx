/*
  GEX ladder view: per-strike net gamma exposure as a horizontal bar ladder
  (hand-rolled SVG — no chart libraries, on purpose), with the spot line,
  the interpolated zero-gamma level, and the engine's convention note shown
  verbatim: the sign convention is an assumption about dealer positioning,
  and the UI must say so rather than dress it up as data.
*/
import { useEffect, useState } from "react";
import { etDateTime, int, signedMoney } from "./format.js";
import type { GexLadder } from "./types.js";

export function GexView({ chains }: { chains: string[] }) {
  const [picked, setPicked] = useState("");
  const active = picked !== "" && chains.includes(picked) ? picked : (chains[0] ?? "");
  const [ladder, setLadder] = useState<GexLadder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (active === "") return;
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/gex/${encodeURIComponent(active)}`, { signal: controller.signal })
      .then(async (res) => {
        const body = (await res.json()) as { gex?: GexLadder; error?: string };
        if (!res.ok || !body.gex) throw new Error(body.error ?? `HTTP ${res.status}`);
        setLadder(body.gex);
        setError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLadder(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [active]);

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
            · {ladder.expiriesIncluded.length} expiries · snapshot {etDateTime(ladder.ts)} ET
          </p>
        )}
        {loading && <span className="text-[10px] text-zinc-600">loading…</span>}
      </div>

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
          <div className="overflow-x-auto rounded border border-zinc-800 bg-zinc-950 p-2">
            <LadderSvg ladder={ladder} />
          </div>
          {ladder.zeroGamma && (
            <p className="text-[10px] text-zinc-600">
              zero-gamma method: {ladder.zeroGamma.method}
            </p>
          )}
        </>
      )}
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
