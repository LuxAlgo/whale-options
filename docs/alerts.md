# Alerts

Alert rules are plain JSON predicates over emitted events, routed to sinks. Three properties are non-negotiable and shape everything below:

- **Secrets are env-var names, never values.** Config and the rules store hold the *name* of the environment variable; the sink reads the value at send time. Nothing secret is ever written to disk by this project.
- **Every fire is recorded with its event id**, so an alert is never a dead ping — it traces back to the complete, replayable event story.
- **Replay never re-fires alerts.** Alerts belong to live runs only.

All sample lines and values in this document are captured from the seeded synthetic feed.

## Rule schema, field by field

```json
{
  "id": "nvda-big-sweeps",
  "name": "NVDA sweeps ≥ 75",
  "enabled": true,
  "match": {
    "minScore": 75,
    "minPremium": 250000,
    "tickers": ["NVDA"],
    "side": ["buy", "sell"],
    "kind": ["sweep"],
    "maxDte": 45,
    "minVolOi": 1,
    "excludeColdStart": true
  },
  "sink": { "type": "discord" },
  "cooldownSec": 300
}
```

| Field | Type / default | Meaning |
|---|---|---|
| `id` | string, required | Rule identity — cooldowns, the audit trail, and CRUD key off it |
| `name` | string, optional | Display name; carried into webhook payloads (`null` when absent) |
| `enabled` | boolean, default `true` | Disabled rules are kept but never match |
| `match.minScore` | number 0–100, optional | Event score must be ≥ this |
| `match.minPremium` | number ≥ 0, optional | Event premium (dollars) must be ≥ this |
| `match.tickers` | string[], optional | Underlyings, case-insensitive; empty/absent = all |
| `match.side` | subset of `buy` `sell` `mid` `unknown`, optional | Aggressor sides that match |
| `match.kind` | subset of `sweep` `block` `split` `print`, optional | Event kinds that match |
| `match.maxDte` | number ≥ 0, optional | Days to expiry must be ≤ this |
| `match.minVolOi` | number ≥ 0, optional | Volume/OI ratio must be ≥ this; an event with no OI (`volOiRatio: null`) does **not** match — no data is not a pass |
| `match.excludeColdStart` | boolean, default **`true`** | Skip events whose score is flagged cold-start. The default is deliberate: fresh installs should not page anyone on half-warmed baselines. Set `false` explicitly if you want day-one alerts |
| `sink` | object, required | Where it goes — one of the five below |
| `cooldownSec` | number ≥ 0, default `60` | Minimum seconds between fires of this rule *for the same contract* |

Empty `match` (`{}`) matches every emitted event (subject to the cold-start default). Invalid rules are rejected with the schema issues verbatim, whether added via CLI, MCP, or config.

## The five sinks

| Sink | Config | Env vars read at send time |
|---|---|---|
| `stdout` | `{ "type": "stdout" }` | none |
| `webhook` | `{ "type": "webhook", "url": "...", "template": "flow-event" \| "order-signal", "secretEnv": "MY_HMAC_SECRET" }` | the var named by `secretEnv` (optional HMAC key) |
| `discord` | `{ "type": "discord", "webhookUrlEnv": "..." }` | `WHALE_DISCORD_WEBHOOK_URL` (default name) |
| `telegram` | `{ "type": "telegram", "botTokenEnv": "...", "chatIdEnv": "..." }` | `WHALE_TELEGRAM_BOT_TOKEN`, `WHALE_TELEGRAM_CHAT_ID` (default names) |
| `desktop` | `{ "type": "desktop" }` | none — native notifications via `osascript` (macOS) or `notify-send` (Linux); reported unsupported elsewhere |

A sink whose env vars are missing fails that delivery with the reason recorded (e.g. `env WHALE_DISCORD_WEBHOOK_URL not set`) — it never blocks the engine and never leaks what the value would have been.

`stdout`, `discord`, `telegram`, and `desktop` all carry the same one-line summary. Captured:

```text
[alert:big-prints] AMD CALL $162.5 2026-09-11 — SWEEP BUY $881,751 (983 contracts, 6 legs, -1.6% ITM dte 18.3) — whale score 67.2 [cold start]
```

## Webhook templates

The webhook sink POSTs JSON (`content-type: application/json`) in one of two shapes.

### `flow-event` (default) — the full story

The entire event, score breakdown included, wrapped with the rule that fired. Shape (values from the captured synthetic event above, long fields elided with `…`):

```jsonc
{
  "source": "whale-options",
  "alert": { "ruleId": "big-prints", "ruleName": null, "firedAt": 1787616251011 },
  "event": {
    "id": "ev_e9033baf68dcc6a5",
    "ts": 1787578223338.0146,
    "sessionDate": "2026-08-24",
    "kind": "sweep", "side": "buy",
    "underlying": "AMD", "contract": "AMD260911C00162500",
    "expiry": "2026-09-11", "strike": 162.5, "right": "C",
    "premium": 881751, "size": 983, "price": 8.97,
    "dte": 18.271, "otmPct": -0.0156, "volOiRatio": 2.693, "oi": 365,
    "legCount": 6, "exchanges": ["Q", "X", "W", "N", "M", "C"],
    "legs": ["… every print with its conditions and the NBBO at print time …"],
    "score": { "total": 67.2, "components": { "…": "…" }, "missing": ["volumeVsBaseline", "premiumVsBaseline"], "coldStart": true },
    "reasons": ["sweep: 6 legs across 6 exchanges in 312ms", "…"]
  }
}
```

### `order-signal` — the compact executor format

The ticker/action body that webhook-driven order executors accept, with full provenance tucked into `meta`:

```jsonc
{
  "ticker": "AMD",
  "action": "buy",           // "sell" for sell-side events; anything else maps to "buy" —
                             // pair this template with a side filter in match
  "quantity": 1,             // fixed: sizing is your executor's decision, not this engine's
  "meta": {
    "source": "whale-options",
    "eventId": "ev_e9033baf68dcc6a5",
    "contract": "AMD260911C00162500",
    "kind": "sweep",
    "premium": 881751,
    "score": 67.2,
    "sessionDate": "2026-08-24"
  }
}
```

Whale Options does not execute orders ([non-goals](../README.md#what-it-deliberately-does-not-do)); this template is the entire relationship to execution. If you wire it to an executor, that decision — and the side filter, the score floor, and the consequences — is yours.

### HMAC signing

With `secretEnv` set, the sink signs the exact request body and sends the signature as a header:

```
x-whale-signature: hex( HMAC-SHA256( body, $MY_HMAC_SECRET ) )
```

Verify by recomputing the HMAC over the raw bytes you received before parsing. No secret in config, no signature — the header is simply absent when the env var is unset.

## Cooldowns

Cooldowns are keyed `rule.id + contract`: `nvda-big-sweeps` firing on the NVDA 2026-09-19 $190 calls does not silence the $195 calls. The default is 60 seconds; `0` disables. State is in-memory for the running engine, so a restart resets cooldown windows — stated so you are not surprised by a duplicate after a restart.

## Delivery and the audit trail

Matching happens on the live event stream; delivery is queued off the hot path (the engine never waits on a sink). Each send gets up to 2 retries with 1 s / 3 s backoff. Every outcome — success or failure, with detail — lands in the `alerts_fired` table:

```text
al_d026c303418ce383  rule=big-prints  event=ev_e9033baf68dcc6a5  sink=stdout  ok=1
```

The stored `event_id` is the whole point: `whale events --id ev_e9033baf68dcc6a5` (or the MCP tool `whale_event`) reconstructs exactly what fired and why — every leg, every sale condition, the NBBO each print was judged against, and the full score decomposition. An alert you cannot audit is a rumor; these are not that.

## Where rules live: `config` vs `dynamic`

Two sources, visible on every rule:

- **`config`** — rules declared under `alerts.rules` in `whale.config.*`. Re-seeded into the store on every `whale run`, so the file is their source of truth: edit or remove them *in the file* (removing a config rule via CLI/MCP only lasts until the next run re-seeds it).
- **`dynamic`** — rules added at runtime via `whale rules add --json '…'` (or `--file`), or via the MCP tool `whale_rules`. Persisted in the flight recorder, they survive restarts; the live engine picks up changes without a restart. Remove with `whale rules remove <id>`.

```bash
whale rules list
whale rules add --json '{ "id": "tsla-blocks", "match": { "tickers": ["TSLA"], "kind": ["block"], "minPremium": 500000 }, "sink": { "type": "stdout" } }'
whale rules remove tsla-blocks
```

Same schema, same validation, same audit trail either way.
