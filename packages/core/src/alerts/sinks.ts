/*
  Alert sinks. Sink secrets never live in config files — config names the
  env var, the sink reads it at send time. The webhook sink's "order-signal"
  template posts the compact {ticker, action, ...} body that webhook-driven
  order executors accept, so a flow alert can drive one directly; the default
  "flow-event" template posts the entire event, score breakdown included.
*/

import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import type { AlertRule } from "../config.js";
import type { FlowEvent } from "../types.js";

export interface SinkResult {
  ok: boolean;
  detail?: string;
}

export type SinkFn = (event: FlowEvent, rule: AlertRule) => Promise<SinkResult>;

function summaryLine(event: FlowEvent): string {
  const otm =
    event.otmPct === null
      ? ""
      : ` ${(event.otmPct * 100).toFixed(1)}% ${event.otmPct >= 0 ? "OTM" : "ITM"}`;
  return (
    `${event.underlying} ${event.right === "C" ? "CALL" : "PUT"} $${event.strike} ${event.expiry} — ` +
    `${event.kind.toUpperCase()} ${event.side.toUpperCase()} $${Math.round(event.premium).toLocaleString("en-US")} ` +
    `(${event.size} contracts, ${event.legCount} leg${event.legCount > 1 ? "s" : ""},${otm} ` +
    `dte ${event.dte.toFixed(1)}) — whale score ${event.score.total}` +
    (event.score.coldStart ? " [cold start]" : "")
  );
}

export function buildWebhookBody(
  event: FlowEvent,
  rule: AlertRule & { sink: { type: "webhook"; template: "flow-event" | "order-signal" } },
): unknown {
  if (rule.sink.template === "order-signal") {
    return {
      ticker: event.underlying,
      action: event.side === "sell" ? "sell" : "buy",
      quantity: 1,
      meta: {
        source: "whale-options",
        eventId: event.id,
        contract: event.contract,
        kind: event.kind,
        premium: event.premium,
        score: event.score.total,
        sessionDate: event.sessionDate,
      },
    };
  }
  return {
    source: "whale-options",
    alert: { ruleId: rule.id, ruleName: rule.name ?? null, firedAt: Date.now() },
    event,
  };
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<SinkResult> {
  const payload = JSON.stringify(body);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: payload,
  });
  if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
  return { ok: true };
}

export function createSink(rule: AlertRule): SinkFn {
  const sink = rule.sink;
  switch (sink.type) {
    case "stdout":
      return async (event) => {
        process.stdout.write(`[alert:${rule.id}] ${summaryLine(event)}\n`);
        return { ok: true };
      };

    case "webhook":
      return async (event, r) => {
        const body = buildWebhookBody(event, r as Parameters<typeof buildWebhookBody>[1]);
        const headers: Record<string, string> = {};
        const secret = sink.secretEnv ? process.env[sink.secretEnv] : undefined;
        if (secret) {
          headers["x-whale-signature"] = createHmac("sha256", secret)
            .update(JSON.stringify(body))
            .digest("hex");
        }
        return postJson(sink.url, body, headers);
      };

    case "discord":
      return async (event) => {
        const url = process.env[sink.webhookUrlEnv];
        if (!url) return { ok: false, detail: `env ${sink.webhookUrlEnv} not set` };
        return postJson(url, { content: summaryLine(event) });
      };

    case "telegram":
      return async (event) => {
        const token = process.env[sink.botTokenEnv];
        const chatId = process.env[sink.chatIdEnv];
        if (!token || !chatId) {
          return { ok: false, detail: `env ${sink.botTokenEnv}/${sink.chatIdEnv} not set` };
        }
        return postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
          chat_id: chatId,
          text: summaryLine(event),
        });
      };

    case "desktop":
      return async (event) => {
        const line = summaryLine(event);
        const attempt = (cmd: string, args: string[]) =>
          new Promise<boolean>((resolve) => {
            execFile(cmd, args, { timeout: 5000 }, (err) => resolve(!err));
          });
        if (process.platform === "darwin") {
          const ok = await attempt("osascript", [
            "-e",
            `display notification ${JSON.stringify(line)} with title "Whale Options"`,
          ]);
          return ok ? { ok } : { ok, detail: "osascript failed" };
        }
        if (process.platform === "linux") {
          const ok = await attempt("notify-send", ["Whale Options", line]);
          return ok ? { ok } : { ok, detail: "notify-send unavailable" };
        }
        return { ok: false, detail: `desktop notifications unsupported on ${process.platform}` };
      };
  }
}
