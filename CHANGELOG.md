# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- pnpm monorepo with `core`, `server` and `cli` packages, strict TypeScript, Biome and Vitest.
- Shared domain contracts, `ProviderError` failover classification and the typed `EventBus`.
- zod configuration schema with ToS-sensitive features disabled by default.
- Architecture, HTTP API and specification documents.
- Dual-brain context system: task graph DAG resolver with cycle paths and status transitions,
  `ProjectBrain` (STATE.md section helpers, atomic writes, lock file, `task.updated` events),
  `GlobalBrain` markdown notes, `buildTaskContext` with budgeted truncation and the master
  `DAVECODE_SYSTEM_PROMPT`.
- Provider adapters in `@davecode/core`: `openai`, `openai-compatible`, `anthropic`, `gemini`,
  `claude-cli` (per-account `CLAUDE_CONFIG_DIR`), `codex-cli` (per-account `CODEX_HOME`) and an
  experimental driver-injected `gemini-web`, all translating to the OpenAI wire format with
  uniform `ProviderError` mapping, plus the `createProviders()` registry.
- MIT license, contributing guide, code of conduct, security policy and CI.
- Layered config loader (defaults, global, project, `DAVECODE_*` env) with file-specific errors.
- SQLite storage (WAL, versioned migrations) with account, usage and audit repositories.
- AES-256-GCM keyring for account secrets with a per-install master key.
- Per-account sandboxes for CLI providers (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) and isolated
  Chromium profiles for experimental browser providers (`playwright-core` optional).
- Token estimation with `js-tiktoken` (`o200k_base`) and a chars/4 fallback.
- Sliding-window quota engine (1 m, 5 h, 24 h) and a SQLite-backed usage tracker.
- Router with quota-aware weighted balancing, backpressure, 5 h quota shift, per-account
  circuit breaker and hot failover (streams fail over only before the first chunk).
- `createEngine()` composition root wiring config, storage, identity, quotas and the router.
- Fastify gateway: OpenAI-compatible `/v1` (JSON + SSE), the full `/api` surface, live
  `/api/events`, bearer auth, CORS for the Vite dev server and optional dashboard hosting.
- `@davecode/ui` web dashboard (Vite, React 19, Tailwind CSS v4): overview with live token burn
  and quota pressure, accounts (add/edit with write-only secrets, gemini-web Terms-of-Service
  gate), traffic with inline failover chains, routes, task graph DAG/board/list with the project
  brain, runner control with a live log console, settings, command palette and keyboard
  shortcuts. Dark by default with a light theme.
- Typed client for every `/api` endpoint plus an `/api/events` stream with backoff reconnects,
  and a realistic in-browser mock mode (`?mock=1`, `VITE_DAVECODE_MOCK=1`, or automatic when the
  gateway is unreachable).
- Autonomous runner (`AutonomousRunner`, `createRunner`): selects the next ready task, works on
  an isolated `davecode/task-<id>` branch, validates with the configured lint/typecheck/test
  commands, self-repairs up to `runner.maxRepairCycles` with the exact failure output, runs an
  optional judge, then commits (Conventional Commits) and merges `--no-ff` or opens a PR with
  `gh`, updating TASK_GRAPH.json and STATE.md. 24/7 mode with idle polling or `runOnce()`;
  refuses a dirty tree; pause/stop at step boundaries with `AbortSignal` cancellation.
- Executors: the default `builtin` OpenAI tool-calling loop over the router (`list_dir`,
  `read_file`, `write_file`, `edit_file`, `search`, `run_command`, `finish`) with repo path
  confinement and a command allow-list, and opt-in `claude-cli` delegation using the account's
  sandboxed `CLAUDE_CONFIG_DIR`.
- Judges: `none` (default), TypeSafe Jev via the OpenRouter Decisions API (key from
  `OPENROUTER_API_KEY` / `JEV_API_KEY`) and `llm` over your own routes with a zod-validated
  verdict.
- `ProjectBrainSource` adapter for the gateway; `pnpm dev` exposes the project brain and runner.
- `runner.*` config: `executor`, `pullRequests`, `commitBrain`, `commandTimeoutMs`,
  `idlePollMs`, `maxIterations`, `maxTaskTokens`, `allowedCommands` and `claudeCli`.
