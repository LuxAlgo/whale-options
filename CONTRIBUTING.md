# Contributing

Thanks for looking under the hood — that is the point of this project. The bar for changes is the same bar the engine holds itself to: deterministic, tested, and honest about what it knows.

## Dev setup

Node ≥ 20.10, [pnpm](https://pnpm.io) 10 (the repo pins `packageManager`).

```bash
pnpm install
pnpm build        # all packages — REQUIRED before typecheck
pnpm typecheck
pnpm test
pnpm lint         # biome; `pnpm lint:fix` to auto-format
```

**Build before typecheck.** `whale-cli` and `whale-mcp` typecheck against `whale-core`'s *built* `dist/index.d.ts`, so a fresh clone (or a change to core's public API) needs `pnpm build` first — CI runs in exactly this order. `better-sqlite3` and `esbuild` are the only packages allowed to run install scripts.

Run the CLI from the workspace while developing:

```bash
node packages/cli/dist/index.js run --feed synthetic --db :memory:
```

## Test map

| Suite | Where | What it pins |
|---|---|---|
| Unit | `packages/core/test/*.test.ts` (classifier, score, greeks, occ, session, histogram, backfill, audit, market, short-volume, daily-history, compare), `packages/mcp/test/` | Module behavior, edge cases, per-vendor feed mappers against invented vendor-shaped fixtures; the audit/market/short-volume suites pin their honesty notes and caveats as behavior, not copy |
| **Goldens** | `packages/core/test/goldens.test.ts` + `fixtures/tapes/` + `fixtures/goldens/` | Committed tapes must classify to the **byte-identical** committed event streams, ids included — plus semantic assertions per edge tape (sweep aggregation, spread-leg silence, cancel voiding, late prints, block floors, cold start, ladders, session rollover) |
| Properties | `packages/core/test/properties.test.ts` | Invariants on *any* tape: no double-counted prints, premium conservation, NDJSON round-trip, bounded emission reordering, scores decompose to their totals |
| Determinism | `packages/core/test/determinism.test.ts` | Same seed ⇒ same tape; same tape + same config ⇒ byte-identical events |

Filter to one suite while iterating:

```bash
pnpm --filter @luxalgo/whale-core exec vitest run goldens
```

### The golden rule

**Goldens must pass.** If your change alters a golden, that is a semantic change to classification — treat it as one:

1. Regenerate deliberately: `UPDATE_GOLDENS=1 pnpm --filter @luxalgo/whale-core exec vitest run goldens`, or `pnpm gen:fixtures` to rewrite tapes and goldens together.
2. The edge tapes' **semantic assertions run in update mode too** — a regeneration can never silently bless a regression (e.g. spread legs starting to score). If a semantic assertion now fails, the assertion must be updated *deliberately*, in the same PR, with the reasoning in the PR description.
3. Golden diffs belong in review: a PR that changes goldens without explaining the classification change it encodes will be asked to.

### Determinism is a constraint, not a suite

The engine is a pure function of the tape ([architecture.md](docs/architecture.md)). Contributions to engine paths must not introduce wall-clock reads, randomness, `Intl`/ICU-dependent formatting, unstable iteration order, or floating output precision. The determinism suite catches most of this; do not make it try.

## Style

[Biome](https://biomejs.dev) is the formatter and linter (`biome.json`: 2-space indent, 100-column lines, double quotes). `pnpm lint:fix` before pushing; CI runs `pnpm lint` first and fails fast.

## No real market data — ever

Recorded vendor market data cannot be redistributed. **Do not commit it**: no captured tapes, no fixture files derived from a live feed, no "just one real print" in a test, no real output pasted into docs. Everything checked in comes from the seeded synthetic feed or hand-built edge tapes (`pnpm gen:fixtures`), and documentation samples are labeled synthetic. PRs containing real tape will be closed with a pointer here.

## Adding a feed adapter

The full contract and checklist live in [docs/feeds.md](docs/feeds.md#the-feedadapter-contract-for-contributors), with the architecture context in [docs/architecture.md](docs/architecture.md#adding-a-feed-adapter). The short version: implement `FeedAdapter`, register it with vendor-named env vars, attach whatever enrichment the vendor sends, add a canary that PASS/SKIP/FAILs on one line, and test the mappers against invented vendor-shaped samples.

### The condition-table citation requirement

The sale-condition mapping is where a feed adapter earns trust, so it carries a documentation burden: **every vendor condition table must cite its sources in a comment** — the vendor's docs page, the official SDK enum, the OPRA participant spec, whatever you actually verified against — the way `feeds/thetadata.ts`, `feeds/massive.ts`, `feeds/alpaca.ts`, and `feeds/tradier.ts` do. Codes you cannot verify map to `"unknown"` (the engine keeps them and flags the events); an uncited guess in a condition table is a correctness bug even when it happens to be right.

## Scope guardrails

Read [the non-goals](README.md#what-it-deliberately-does-not-do) before proposing features. PRs adding hosted/multi-tenant modes, order execution, real-time dark-pool claims, or telemetry of any kind will be declined regardless of quality — those are constitution, not backlog.

## Developer Certificate of Origin

Contributions require a DCO sign-off: every commit in a pull request must carry a `Signed-off-by: Your Name <you@example.com>` trailer. Add it with `git commit -s` (or `git rebase --signoff` for existing commits). CI enforces this. Signing off certifies the [Developer Certificate of Origin](https://developercertificate.org/).
