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
