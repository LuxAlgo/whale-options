# Changelog

## Unreleased

Charting: flow on the tape.

- Per-print flow series in `whale-core` (`flow/`): every normalized print — no premium floor — bucketed per underlying and session into signed call/put premium, directional delta (chain greeks when the run has them, else Black-Scholes from the print's own NBBO mid/spot, else counted as missing), net volume, and the spot tape from prints; persisted by both flight recorders (SQLite schema v3, additive), replay-identical, and served by `GET /api/flow/sessions`, `GET /api/flow/:underlying/series`, and `/ws` `flow` frames
- `FeedAdapter.getUnderlyingBars` (optional): equity bars from Alpaca and Massive, the synthetic feed's own seeded spot walk for the zero-key demo; `GET /api/bars/:underlying` serves them and falls back to the spot tape from prints, stating the source in every payload
- GEX: `computeGex` accepts a spot override and every ladder carries a `pricing` line ("chain as of …, re-priced at spot … at …"); new `computeGexHeatmap` (strike × expiry grid with totals, spot row, zero-gamma) at `GET /api/gex/:underlying/heatmap`; `GET /api/gex/:underlying?spot=` re-prices the ladder
- Dashboard: a `chart` tab drawn by [Vela](https://github.com/LuxAlgo/Vela) (lazy-loaded so the flow table's bundle is unchanged) — underlying candles, net premium / directional delta / net volume panes, sweep/block/split markers that open the event drawer, GEX levels overlay, live via `/ws`, underlying and session pickers; the `gex` tab gains the heatmap and live re-pricing at the latest spot every ~2s while visible
- MCP: `whale_flow_series`, `whale_bars`, `whale_gex_heatmap` (sixteen tools)
- `THIRD_PARTY_NOTICES.md` for the bundled Vela (Apache-2.0)

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
