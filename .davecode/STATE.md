# DaveCode: project state

_Last updated: 2026-10-06_

## Current focus

Foundation complete. Phases 1–3 and the dashboard are being built in parallel on feature
branches against the contracts in `packages/core/src/types.ts` and `docs/API.md`.

## Done

- pnpm monorepo, strict TypeScript, Biome, Vitest, tsup, CI matrix (Linux/macOS/Windows).
- Shared contracts, `ProviderError`, `EventBus`, config schema, path helpers.
- OSS docs: README, LICENSE (MIT), CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, CHANGELOG.

## Blockers

None.

## Decisions log

| Date | Decision |
| :--- | :------- |
| 2026-10-06 | Node ≥ 22.12 + pnpm monorepo; `better-sqlite3`; Fastify; Ink TUI + Vite/React dashboard |
| 2026-10-06 | ToS-sensitive features (`gemini-web`, multi-account rotation) ship behind `experimental.*` flags, off by default |
| 2026-10-06 | Judge defaults to deterministic checks (free). TypeSafe Jev is optional and paid |
| 2026-10-06 | MIT license; English for code, docs and commits |
