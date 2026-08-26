# Changelog

## 0.1.0

Initial public release.

- Pure event-time engine: sweep, block, and split classification with an explicit policy table for sale conditions
- Six-component whale score with rolling baselines, weight renormalization, and per-contract cold-start flagging
- Determinism contract: same tape + same config produce a byte-identical event stream, ids included
- Feed adapters: ThetaData, Massive (formerly Polygon), Alpaca, and Tradier, plus the seeded synthetic feed and tape replay
- SQLite flight recorder with historical backfill, outcome audit, market-structure analytics (OI deltas, max pain, IV rank, net flow), FINRA short-volume context, and feed cross-validation
- Alerts: plain-JSON rules, five sinks, HMAC-signed webhooks, per-rule cooldowns
- Local dashboard (flow, GEX ladder, market, audit, playback) served by the engine
- MCP server with thirteen tools over stdio and local streamable HTTP
