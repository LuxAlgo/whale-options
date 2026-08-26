/*
  Local HTTP + WebSocket server: the dashboard's data source and a LAN-usable
  read surface. Binds 127.0.0.1 by default — this is a single-user,
  self-hosted tool and never a multi-tenant service. Endpoints are thin reads
  over the flight recorder; live events are pushed onto /ws by the runner.
  When a built dashboard is available (options.staticDir) the same port also
  serves it as static files, with an index.html fallback for client routes.
*/
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { type WebSocket, WebSocketServer } from "ws";
import { AUDIT_HORIZONS, type AuditHorizon, calibrate } from "../audit/index.js";
import { alertRuleSchema, type WhaleConfig } from "../config.js";
import { shortVolumeReport } from "../context/index.js";
import { computeGex } from "../greeks/gex.js";
import { ivRank, maxPain, netFlowReport, oiDeltas } from "../market/index.js";
import type { FlightRecorder } from "../store/types.js";
import type { EventKind, FlowEvent, Side } from "../types.js";

export interface WhaleServer {
  listen(): Promise<{ host: string; port: number }>;
  broadcast(event: FlowEvent): void;
  close(): Promise<void>;
}

export function createWhaleServer(opts: {
  store: FlightRecorder;
  config: WhaleConfig;
  /** Extra fields merged into /api/status (feed id, universe, ...). */
  statusExtras?: () => Record<string, unknown>;
  /** Built dashboard directory. When set, GETs outside /api and /ws serve
   *  its files (SPA fallback to index.html); when absent the server is
   *  API-only — the CLI degrades silently if the dashboard isn't installed. */
  staticDir?: string;
}): WhaleServer {
  const { store, config } = opts;
  const sockets = new Set<WebSocket>();

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    if (req.method === "GET" && path === "/api/status") {
      sendJson(res, 200, {
        ...store.status(),
        // Underlyings with a chain snapshot — what /api/gex can answer for.
        chains_available: store.listChainSnapshots().map((c) => c.underlying),
        ...(opts.statusExtras?.() ?? {}),
      });
      return;
    }

    if (req.method === "GET" && path === "/api/events") {
      const q = url.searchParams;
      const events = store.queryEvents({
        underlying: q.get("underlying") ?? undefined,
        contract: q.get("contract") ?? undefined,
        kind: (q.get("kind") as EventKind | null) ?? undefined,
        side: (q.get("side") as Side | null) ?? undefined,
        minPremium: numberParam(q.get("minPremium")),
        minScore: numberParam(q.get("minScore")),
        excludeColdStart: q.get("excludeColdStart") === "true",
        from: numberParam(q.get("from")),
        to: numberParam(q.get("to")),
        limit: numberParam(q.get("limit")),
        orderBy: q.get("orderBy") === "score" ? "score" : "ts",
      });
      // The store returns newest/highest first; order=asc flips the page so
      // playback consumers can walk the tape forward without re-sorting.
      if (q.get("order") === "asc") events.reverse();
      sendJson(res, 200, { events });
      return;
    }

    const eventMatch = /^\/api\/events\/([A-Za-z0-9_]+)$/.exec(path);
    if (req.method === "GET" && eventMatch?.[1]) {
      const event = store.getEvent(eventMatch[1]);
      if (!event) {
        sendJson(res, 404, { error: `no event with id ${eventMatch[1]}` });
        return;
      }
      sendJson(res, 200, { event });
      return;
    }

    const gexMatch = /^\/api\/gex\/([A-Za-z0-9.]+)$/.exec(path);
    if (req.method === "GET" && gexMatch?.[1]) {
      const snapshot = store.getChainSnapshot(gexMatch[1]);
      if (!snapshot) {
        sendJson(res, 404, {
          error: `no chain snapshot for ${gexMatch[1].toUpperCase()}; is it in universe.underlyings?`,
        });
        return;
      }
      const ladder = computeGex(snapshot, {
        r: config.greeks.r,
        q: config.greeks.qByUnderlying[snapshot.underlying] ?? config.greeks.q,
        convention: config.greeks.gexConvention,
        expiry: url.searchParams.get("expiry") ?? undefined,
      });
      if (!ladder) {
        sendJson(res, 422, { error: "chain snapshot has no usable contracts (no OI/IV/greeks)" });
        return;
      }
      sendJson(res, 200, { gex: ladder });
      return;
    }

    // Market-structure analytics (Wave 3) — thin reads over the daily-history
    // layer. Notes/caveats in every payload pass through untouched: the UI is
    // required to show them, so the server never strips or rewrites them.
    if (req.method === "GET" && path === "/api/market/netflow") {
      const q = url.searchParams;
      const status = store.status();
      const to = numberParam(q.get("to")) ?? status.lastTickTs ?? status.lastEventTs ?? Date.now();
      const from = numberParam(q.get("from")) ?? to - 390 * 60_000;
      sendJson(res, 200, {
        netflow: netFlowReport(store, from, to, { top: numberParam(q.get("top")) ?? 15 }),
      });
      return;
    }

    const oiMatch = /^\/api\/market\/oi\/([A-Za-z0-9.]+)$/.exec(path);
    if (req.method === "GET" && oiMatch?.[1]) {
      const q = url.searchParams;
      sendJson(res, 200, {
        oi: oiDeltas(store, oiMatch[1], {
          sessions: numberParam(q.get("sessions")),
          top: numberParam(q.get("top")),
          minOi: numberParam(q.get("minOi")),
        }),
      });
      return;
    }

    const maxPainMatch = /^\/api\/market\/maxpain\/([A-Za-z0-9.]+)$/.exec(path);
    if (req.method === "GET" && maxPainMatch?.[1]) {
      sendJson(res, 200, {
        maxpain: maxPain(store, maxPainMatch[1], url.searchParams.get("expiry") ?? undefined),
      });
      return;
    }

    const ivRankMatch = /^\/api\/market\/ivrank\/([A-Za-z0-9.]+)$/.exec(path);
    if (req.method === "GET" && ivRankMatch?.[1]) {
      sendJson(res, 200, { ivrank: ivRank(store, ivRankMatch[1]) });
      return;
    }

    // Outcome calibration over the recorded tape. Defaults to the full
    // recorded range; an empty store is a 422 with a readable error, not a
    // stack trace. The caveats block ships in every 200 — non-optional.
    if (req.method === "GET" && path === "/api/audit") {
      const q = url.searchParams;
      const horizon = q.get("horizon") ?? "1h";
      if (!AUDIT_HORIZONS.includes(horizon as AuditHorizon)) {
        sendJson(res, 400, {
          error: `unknown horizon '${horizon}'; one of ${AUDIT_HORIZONS.join(", ")}`,
        });
        return;
      }
      const status = store.status();
      const from = numberParam(q.get("from")) ?? status.firstTickTs ?? undefined;
      const to = numberParam(q.get("to")) ?? status.lastTickTs ?? status.lastEventTs ?? undefined;
      if (from === undefined || to === undefined) {
        sendJson(res, 422, {
          error:
            "nothing recorded yet: the flight recorder has no ticks (pass from/to to override)",
        });
        return;
      }
      try {
        const report = await calibrate({
          store,
          from,
          to,
          horizon: horizon as AuditHorizon,
          underlying: q.get("underlying") ?? undefined,
          excludeColdStart: q.get("excludeColdStart") === "true",
        });
        sendJson(res, 200, { audit: report });
      } catch (err) {
        sendJson(res, 422, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // FINRA short-volume context — cache-read only, never a network call.
    const shortVolMatch = /^\/api\/context\/short-volume\/([A-Za-z0-9.]+)$/.exec(path);
    if (req.method === "GET" && shortVolMatch?.[1]) {
      sendJson(res, 200, {
        shortVolume: shortVolumeReport(
          store,
          shortVolMatch[1],
          numberParam(url.searchParams.get("days")),
        ),
      });
      return;
    }

    if (req.method === "GET" && path === "/api/rules") {
      sendJson(res, 200, { rules: store.listRules() });
      return;
    }

    if (req.method === "POST" && path === "/api/rules") {
      const body = await readBody(req);
      const parsed = alertRuleSchema.safeParse(body);
      if (!parsed.success) {
        sendJson(res, 400, { error: parsed.error.issues.map((i) => i.message).join("; ") });
        return;
      }
      store.upsertRule(parsed.data, "dynamic");
      sendJson(res, 200, { ok: true, rule: parsed.data });
      return;
    }

    const ruleMatch = /^\/api\/rules\/([A-Za-z0-9_-]+)$/.exec(path);
    if (req.method === "DELETE" && ruleMatch?.[1]) {
      sendJson(res, 200, { removed: store.removeRule(ruleMatch[1]) });
      return;
    }

    if (req.method === "GET" && path === "/api/alerts") {
      const limit = numberParam(url.searchParams.get("limit")) ?? 100;
      sendJson(res, 200, { alerts: store.listAlertsFired(limit) });
      return;
    }

    const method = req.method ?? "GET";
    if (
      opts.staticDir &&
      (method === "GET" || method === "HEAD") &&
      path !== "/ws" &&
      path !== "/api" &&
      !path.startsWith("/api/")
    ) {
      const served = await serveStatic(res, opts.staticDir, path, method === "HEAD");
      if (served) return;
    }

    sendJson(res, 404, { error: `no route: ${req.method} ${path}` });
  }

  return {
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.server.port, config.server.host, () => {
          resolve({ host: config.server.host, port: config.server.port });
        });
      }),
    broadcast: (event: FlowEvent) => {
      if (sockets.size === 0) return;
      const payload = JSON.stringify({ type: "event", event });
      for (const socket of sockets) {
        if (socket.readyState === socket.OPEN) socket.send(payload);
      }
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.close();
        wss.close(() => server.close(() => resolve()));
      }),
  };
}

/** The dashboard build only contains these; anything else is served opaque. */
const STATIC_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/**
 * Serve one file from staticDir. Returns false (caller 404s) for traversal
 * attempts, missing assets, and anything that isn't a plain file. Unknown
 * extensionless paths fall back to index.html so client-side routes reload.
 */
async function serveStatic(
  res: ServerResponse,
  staticDir: string,
  pathname: string,
  headOnly: boolean,
): Promise<boolean> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (decoded.includes("\0")) return false;
  const root = resolve(staticDir);
  // Normalize, then reject anything that escapes the static root.
  const target = normalize(join(root, decoded));
  if (target !== root && !target.startsWith(root + sep)) return false;

  const file = await pickFile(target, root);
  if (!file) return false;
  const data = await readFile(file).catch(() => null);
  if (data === null) return false;

  res.writeHead(200, {
    "content-type": STATIC_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": data.byteLength,
    // Vite content-hashes everything under assets/; index.html must revalidate.
    "cache-control": file.includes(`${sep}assets${sep}`)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  });
  res.end(headOnly ? undefined : data);
  return true;
}

async function pickFile(target: string, root: string): Promise<string | null> {
  const direct = await stat(target).catch(() => null);
  if (direct?.isFile()) return target;
  if (direct?.isDirectory()) {
    const index = join(target, "index.html");
    const st = await stat(index).catch(() => null);
    return st?.isFile() ? index : null;
  }
  if (extname(target) !== "") return null; // a missing asset is a real 404
  const fallback = join(root, "index.html");
  const st = await stat(fallback).catch(() => null);
  return st?.isFile() ? fallback : null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

function numberParam(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error("request body is not valid JSON");
  }
}
