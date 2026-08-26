/*
  Event drawer — the product's thesis on screen. A row tells you *what*
  printed; this drawer shows the *work*: the whale score rebuilt component by
  component with the raw inputs each one saw, what was missing (and that the
  weights renormalized), the classification reasons trail, and the leg-level
  tape with the NBBO each print was judged against. Fetches the flight
  recorder's fresh copy of the event; the clicked row seeds the view so it
  opens instantly.
*/
import { useEffect, useState } from "react";
import { ContractText, KindBadge, RightText, SideText, scoreClass } from "./event-bits.js";
import { etDateTime, etTimeMs, int, money, rawValue, strikeText } from "./format.js";
import type { FlowEvent, ScoreComponent, ScoreComponentName } from "./types.js";

const COMPONENT_ORDER: ScoreComponentName[] = [
  "volumeVsBaseline",
  "premiumVsBaseline",
  "volOi",
  "aggression",
  "urgency",
  "repetition",
];

export function EventDrawer({ seed, onClose }: { seed: FlowEvent; onClose: () => void }) {
  const [fresh, setFresh] = useState<FlowEvent | null>(null);
  const [fetchNote, setFetchNote] = useState<string | null>(null);

  useEffect(() => {
    setFresh(null);
    setFetchNote(null);
    const controller = new AbortController();
    let attempt = 0;
    let timer: number | undefined;
    const load = () => {
      fetch(`/api/events/${encodeURIComponent(seed.id)}`, { signal: controller.signal })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<{ event?: FlowEvent }>;
        })
        .then((body) => {
          if (body.event) {
            setFresh(body.event);
            setFetchNote(null);
          }
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          attempt += 1;
          // A just-streamed event reaches the flight recorder on the runner's
          // next batch flush (≤5s); retry quietly before saying anything.
          if (attempt < 4) {
            timer = window.setTimeout(load, 1_800);
            return;
          }
          setFetchNote(
            `showing the streamed copy; flight recorder fetch failed (${err instanceof Error ? err.message : String(err)})`,
          );
        });
    };
    load();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [seed.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const event = fresh ?? seed;

  return (
    <>
      {/* click-to-close backdrop; Escape covers keyboards */}
      <div className="fixed inset-0 z-30 bg-black/60" onClick={onClose} aria-hidden="true" />
      <aside
        role="dialog"
        aria-label="event detail"
        className="fixed inset-y-0 right-0 z-40 w-full max-w-xl overflow-y-auto border-l border-zinc-800 bg-zinc-950 text-zinc-100"
      >
        <header className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/95 px-5 py-3 backdrop-blur">
          <div className="flex items-center gap-3">
            <KindBadge kind={event.kind} />
            <span className="text-xs w-8">
              <SideText side={event.side} />
            </span>
            <span className="text-sm font-bold">
              {event.underlying} <ContractText event={event} />
            </span>
            <span className="ml-auto text-xs text-zinc-400">
              {int(event.size)} @ {event.price.toFixed(2)} ·{" "}
              <span className="text-zinc-200">{money(event.premium)}</span>
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="close"
              className="rounded border border-zinc-800 px-2 py-0.5 text-xs text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
            >
              esc
            </button>
          </div>
          <p className="mt-1.5 text-[10px] text-zinc-500">
            {etDateTime(event.ts)} ET · session {event.sessionDate} · {event.contract} · {event.id}{" "}
            · feed {event.feedId}
          </p>
          {fetchNote && <p className="mt-1 text-[10px] text-amber-400">{fetchNote}</p>}
        </header>

        <div className="space-y-5 px-5 py-4">
          <FillFacts event={event} />
          <ScoreSection event={event} />
          <ReasonsTrail reasons={event.reasons} />
          <LegsTable event={event} />
        </div>
      </aside>
    </>
  );
}

function FillFacts({ event }: { event: FlowEvent }) {
  const otm =
    event.otmPct === null
      ? "n/a"
      : event.otmPct >= 0
        ? `${(event.otmPct * 100).toFixed(1)}% OTM`
        : `${(-event.otmPct * 100).toFixed(1)}% ITM`;
  const facts: Array<[string, string]> = [
    ["expiry", `${event.expiry} (${event.dte.toFixed(1)}d)`],
    [
      "strike / spot",
      `${strikeText(event.strike)} / ${event.spot === null ? "n/a" : `$${event.spot.toFixed(2)}`}`,
    ],
    ["moneyness", otm],
    ["vol/OI", event.volOiRatio === null ? "n/a" : event.volOiRatio.toFixed(2)],
    ["open interest", event.oi === null ? "n/a" : int(event.oi)],
    ["legs / exchanges", `${event.legCount} / ${event.exchanges.join(" ") || "n/a"}`],
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
      {facts.map(([label, value]) => (
        <div key={label} className="rounded border border-zinc-800/80 px-2.5 py-1.5">
          <dt className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</dt>
          <dd className="mt-0.5 text-xs text-zinc-200">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ScoreSection({ event }: { event: FlowEvent }) {
  const { score } = event;
  return (
    <section>
      <div className="flex items-baseline gap-3">
        <h2 className="text-[10px] uppercase tracking-wide text-zinc-500">whale score</h2>
        <span className={`text-3xl leading-none ${scoreClass(score.total)}`}>
          {score.total.toFixed(0)}
        </span>
        <span className="text-xs text-zinc-600">/ 100</span>
        {score.coldStart && (
          <span className="text-[10px] text-amber-400/90">
            * cold start ({score.baselineDays} baseline session
            {score.baselineDays === 1 ? "" : "s"})
          </span>
        )}
      </div>
      <div className="mt-3 space-y-3">
        {COMPONENT_ORDER.map((name) => (
          <ComponentRow key={name} name={name} component={score.components[name]} />
        ))}
      </div>
      {score.missing.length > 0 && (
        <p className="mt-3 text-[10px] text-zinc-500">
          missing inputs: {score.missing.join(", ")}; those components are excluded and the
          remaining weights renormalized; the score never pretends it knew something it didn't.
        </p>
      )}
    </section>
  );
}

function ComponentRow({ name, component }: { name: string; component: ScoreComponent }) {
  const width = component.value === null ? 0 : Math.min(100, Math.max(0, component.value * 100));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-xs ${component.value === null ? "text-zinc-600" : "text-zinc-300"}`}>
          {name}
        </span>
        <span className="text-xs tabular-nums text-zinc-400">
          {component.value === null ? "n/a" : `${(component.weighted ?? 0).toFixed(1)} pts`}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-sm bg-zinc-800/80">
        {component.value !== null && (
          <div className="h-full rounded-sm bg-zinc-200" style={{ width: `${width}%` }} />
        )}
      </div>
      <p className="mt-1 break-words text-[10px] leading-4 text-zinc-500">
        {component.value === null ? (
          <span className="italic">({component.note ?? "unavailable"})</span>
        ) : (
          Object.entries(component.raw).map(([key, value]) => (
            <span key={key} className="mr-2 whitespace-nowrap">
              {key}=<span className="text-zinc-400">{rawValue(value)}</span>
            </span>
          ))
        )}
      </p>
    </div>
  );
}

function ReasonsTrail({ reasons }: { reasons: string[] }) {
  return (
    <section>
      <h2 className="text-[10px] uppercase tracking-wide text-zinc-500">reasons</h2>
      {reasons.length === 0 ? (
        <p className="mt-1.5 text-xs text-zinc-600">none recorded</p>
      ) : (
        <ul className="mt-1.5 space-y-1">
          {reasons.map((reason) => (
            <li key={reason} className="text-xs leading-5 text-zinc-400">
              <span className="text-zinc-600">· </span>
              {reason}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LegsTable({ event }: { event: FlowEvent }) {
  return (
    <section>
      <h2 className="text-[10px] uppercase tracking-wide text-zinc-500">legs ({event.legCount})</h2>
      <div className="mt-1.5 overflow-x-auto rounded border border-zinc-800/80">
        <table className="w-full text-left text-[11px] tabular-nums">
          <thead>
            <tr className="border-b border-zinc-800 text-[10px] uppercase text-zinc-500">
              <th className="px-2 py-1 font-normal">ts (ET)</th>
              <th className="px-2 py-1 font-normal">exch</th>
              <th className="px-2 py-1 text-right font-normal">size @ price</th>
              <th className="px-2 py-1 text-right font-normal">nbbo @ print</th>
              <th className="px-2 py-1 font-normal">conditions</th>
            </tr>
          </thead>
          <tbody>
            {event.legs.map((leg) => (
              <tr key={leg.seq} className="border-b border-zinc-900 last:border-0">
                <td className="px-2 py-1 text-zinc-400">{etTimeMs(leg.ts)}</td>
                <td className="px-2 py-1 text-zinc-300">{leg.exchange}</td>
                <td className="px-2 py-1 text-right text-zinc-200">
                  {int(leg.size)} @ {leg.price.toFixed(2)}
                </td>
                <td className="px-2 py-1 text-right text-zinc-400">
                  {leg.nbbo ? (
                    <>
                      {leg.nbbo.bid.toFixed(2)} / {leg.nbbo.ask.toFixed(2)}{" "}
                      <span className="text-zinc-600">
                        ({int(leg.nbbo.bidSize)}×{int(leg.nbbo.askSize)})
                      </span>
                    </>
                  ) : (
                    "n/a"
                  )}
                </td>
                <td className="px-2 py-1 text-zinc-500">{leg.conditions.join(", ") || "n/a"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[10px] text-zinc-600">
        the NBBO shown is the quote each print was judged against at ingest:{" "}
        <RightText right={event.right} /> {strikeText(event.strike)} {event.expiry}
      </p>
    </section>
  );
}
