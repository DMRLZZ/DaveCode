# Agent guide

Instructions for AI coding agents (Claude Code, Codex, opencode, Cursor, DaveCode itself)
working in this repository. Humans should read [CONTRIBUTING.md](CONTRIBUTING.md).

## Before you change anything

1. Read `.davecode/STATE.md` and `.davecode/ARCHITECTURE.md`.
2. Shared contracts are in `packages/core/src/types.ts` and `packages/core/src/events.ts`.
   Build against them; if you must change one, update `docs/API.md` in the same commit.

## Commands

```bash
pnpm install
pnpm lint          # Biome: must pass (pnpm lint:fix auto-fixes)
pnpm typecheck     # strict tsc in every package
pnpm test          # Vitest, run from the repo root
pnpm build         # tsup builds
```

All four must exit 0 before you consider work done.

## Conventions

- ESM + TypeScript strict. Imports between files in a package are extensionless (`./errors`);
  between packages use the package name (`@davecode/core`).
- `core` must not import `server`, `cli` or `ui`. `server` contains no business logic.
- Validate untrusted input (config files, HTTP bodies, task graphs, provider responses) with zod.
- Map upstream failures to `ProviderError` with the right `kind`.
- Never log, emit or return secrets. Use temp dirs (`DAVECODE_HOME`) in tests; never touch the
  real `~/.davecode`.
- Tests live next to the code as `*.test.ts`. No network calls in tests: mock `fetch` or spin
  up a local server.
- ToS-sensitive behaviour goes behind an `experimental.*` flag that defaults to off.

## Git

- Conventional Commits (`feat(core): …`, `fix(server): …`, `test(core): …`, `docs: …`).
- Small, focused commits that each build. Not one giant commit, not one per line.
- Every commit message ends with the agent's co-author trailer when an agent wrote the code.
