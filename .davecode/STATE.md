# DaveCode: project state

_Last updated: 2026-10-06_

## Current focus

**v0.2.0 is released**: `davecode` is a standalone package, the dashboard can edit tasks and
routes, and the runner completed a real implement → test → merge loop on a free local model
(`qwen3:8b` via Ollama). Next up: publishing to npm and dogfooding the runner on this repository
with a frontier model.

## Done

- **Foundation** (#1): pnpm monorepo, strict TypeScript, Biome, Vitest, tsup, CI on
  Linux/macOS/Windows, shared contracts, config schema, OSS docs.
- **Phase 1** (#9): layered config loader, SQLite (WAL) storage, AES-256-GCM keyring,
  per-account sandboxes, Chromium profiles.
- **Phase 2** (#7, #10): seven provider adapters, sliding-window quota engine, hot-failover
  router with circuit breaker, OpenAI-compatible gateway with dashboard API and SSE.
- **Phase 3** (#6): task graph DAG resolver, project and global brains, task context builder.
- **Phase 4** (#13): autonomous runner with builtin and claude-cli executors, validator,
  repair cycles, git flow and optional judge (none / TypeSafe Jev / LLM).
- **Phase 5** (#11, #14): web dashboard and the `davecode` CLI with the chat TUI and runner view.
- **Contract hardening** (#12): SSE ids with `Last-Event-ID` resume, `Account.hasSecret`.
- **v0.2.0** (#16–#18): standalone package, task/route editing, targeted runs, and fixes found by
  running against real Ollama models (cancellations, empty finishes, double-escaped edits).

## Blockers

None.

## Known limitations

- `davecode` is not published to npm yet (install from a tarball or source).
- Small local models: `llama3.1:8b` hallucinates edit arguments; use `qwen3:8b` or a frontier model
  for `davecode run`.
- The `codex-cli` adapter's event parser has not been verified against a real Codex install.
- The TUIs are covered by `ink-testing-library` tests; they still need manual passes in
  Windows Terminal, iTerm2 and common Linux terminals.

## Decisions log

| Date | Decision |
| :--- | :------- |
| 2026-10-06 | Node ≥ 22.12 + pnpm monorepo; `better-sqlite3`; Fastify; Ink TUI + Vite/React dashboard |
| 2026-10-06 | ToS-sensitive features (`gemini-web`, multi-account rotation) ship behind `experimental.*` flags, off by default |
| 2026-10-06 | Judge defaults to deterministic checks (free). TypeSafe Jev is optional and paid |
| 2026-10-06 | MIT license; English for code, docs and commits |
| 2026-10-06 | Stay on TypeScript 5.x: TS 7 (native port) lacks the compiler API used by tsup's dts build |
| 2026-10-06 | `context_length` errors fail over without cooling the account down (the prompt is at fault) |

## Activity log

- 2026-10-06: v0.1.0 release prepared; task graph updated through `davecode tasks status`.
- 2026-10-06: v0.1.0 tagged and published as a GitHub release.
- 2026-10-06: first autonomous success on a free local model (qwen3:8b); v0.2.0 released.
