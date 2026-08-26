/*
  Alert dispatcher: evaluates stored rules against the live event stream and
  delivers to sinks off the hot path. Sends are queued and retried (2 retries,
  1s/3s backoff); every outcome is recorded in alerts_fired with the event id,
  so `whale_event <id>` reconstructs exactly what fired and why.
*/

import type { FlightRecorder } from "../store/types.js";
import type { FlowEvent } from "../types.js";
import { sha256Hex } from "../util/hash.js";
import { ruleMatches } from "./match.js";
import { createSink, type SinkFn } from "./sinks.js";

const RETRY_DELAYS_MS = [1000, 3000];

export class AlertDispatcher {
  private sinks = new Map<string, SinkFn>();
  private lastFired = new Map<string, number>(); // ruleId|contract → wall ts
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(private readonly store: FlightRecorder) {}

  /** Evaluate an event against all stored rules; enqueue matching sends. */
  dispatch(event: FlowEvent): number {
    let matched = 0;
    for (const { rule } of this.store.listRules()) {
      if (!ruleMatches(rule, event)) continue;
      const cooldownKey = `${rule.id}|${event.contract}`;
      const now = Date.now();
      const last = this.lastFired.get(cooldownKey);
      if (last !== undefined && now - last < rule.cooldownSec * 1000) continue;
      this.lastFired.set(cooldownKey, now);
      matched++;

      let sink = this.sinks.get(rule.id);
      if (!sink) {
        sink = createSink(rule);
        this.sinks.set(rule.id, sink);
      }
      const send = sink;
      this.pending++;
      this.queue = this.queue.then(async () => {
        let ok = false;
        let detail: string | undefined;
        for (let attempt = 0; ; attempt++) {
          try {
            const result = await send(event, rule);
            ok = result.ok;
            detail = result.detail;
          } catch (err) {
            ok = false;
            detail = err instanceof Error ? err.message : String(err);
          }
          const delay = RETRY_DELAYS_MS[attempt];
          if (ok || delay === undefined) break;
          await new Promise((r) => setTimeout(r, delay));
        }
        this.store.insertAlertFired({
          id: `al_${sha256Hex(`${rule.id}|${event.id}`).slice(0, 16)}`,
          ruleId: rule.id,
          eventId: event.id,
          ts: Date.now(),
          sink: rule.sink.type,
          ok,
          ...(detail ? { detail } : {}),
        });
        this.pending--;
      });
    }
    return matched;
  }

  /** Rule definitions may have changed (MCP/CLI edits); rebuild sinks lazily. */
  invalidateSinks(): void {
    this.sinks.clear();
  }

  /** Wait for in-flight sends — call before process exit. */
  async drain(): Promise<void> {
    while (this.pending > 0) await this.queue;
    await this.queue;
  }
}
