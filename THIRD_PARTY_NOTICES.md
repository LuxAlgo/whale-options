# Third-party notices

Whale Options is MIT licensed ([LICENSE](LICENSE)). The published packages bundle or depend on the following third-party software whose licenses ask for a notice to travel with redistributions.

## Vela

`@luxalgo/whale-dashboard` bundles [Vela](https://github.com/LuxAlgo/Vela) (`@luxalgo/vela`), LuxAlgo's open-source charting library, into its built `dist/` to draw the chart tab in the browser.

- License: Apache License, Version 2.0 — <https://github.com/LuxAlgo/Vela/blob/main/LICENSE>
- NOTICE: <https://github.com/LuxAlgo/Vela/blob/main/NOTICE> (the same file ships inside the `@luxalgo/vela` npm package)

Vela's NOTICE carries an attribution requirement: charts rendered by the library must show a visible attribution to the Vela project. Whale Options keeps Vela's built-in attribution mark (the logomark at the bottom-left of every chart, linking to the project page) enabled and does not disable, hide, or obscure it; the dashboard additionally names and links Vela in the chart tab's footer. Redistributions of the dashboard build must keep that mark on.

Every other runtime dependency (React, better-sqlite3, ws, zod, the MCP SDK, and their transitive dependencies) is MIT/ISC/BSD/Apache-2.0 licensed and is not bundled into a published package beyond the dashboard's React runtime; the CI gate `scripts/check-licenses.mjs` enforces the license allowlist for the whole lockfile.
