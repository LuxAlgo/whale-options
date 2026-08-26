# Security

Whale Options is self-hosted, single-user software. Its security model is short because its attack surface is deliberately small.

## Posture

- **No telemetry.** The engine, CLI, MCP server, and dashboard phone home to no one — no analytics, no crash reporting, no update pings. The only network I/O is to the market-data vendor you configured and to the alert sinks you configured.
- **Credentials are env vars, and they never leave your machine** except to the vendor they authenticate (e.g. `TRADIER_ACCESS_TOKEN` is sent to Tradier and nowhere else). Config files and the flight recorder store env-var *names*, never secret values. Nothing secret is written to disk by this project.
- **Servers bind loopback by default.** The engine's HTTP/WS API and dashboard bind `127.0.0.1:8787`; the MCP server's HTTP transport binds `127.0.0.1`. Neither has an auth layer — they are single-user, local-first surfaces. Binding wider (`server.host` / `--host`) is an explicit choice for a trusted LAN; do not expose them to the open internet.
- **Webhook payloads can be signed** (HMAC-SHA256 via `secretEnv`, `x-whale-signature` header) so a receiver can verify origin — see [docs/alerts.md](docs/alerts.md).
- **No execution paths.** The engine emits signals only; there is no order routing to compromise.

## Reporting a vulnerability

Please report vulnerabilities privately via **GitHub security advisories on this repository**: [Security → Advisories → Report a vulnerability](https://github.com/LuxAlgo/whale-options/security/advisories/new). Do not open a public issue for a security problem.

Include what you can: affected package (`whale-core` / `whale-cli` / `whale-mcp` / `whale-dashboard`), a reproduction, and impact as you understand it. Reports are read by the maintainers; fixes ship as ordinary releases with credit to the reporter unless you prefer otherwise.

In scope: anything in this repository — the engine, the CLI, the MCP server, the dashboard, the feed adapters, and the alert sinks. Vendor-side issues (a market-data provider's API or account security) belong with the vendor.
