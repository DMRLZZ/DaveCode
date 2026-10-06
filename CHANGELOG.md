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
