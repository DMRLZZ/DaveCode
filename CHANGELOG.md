# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- First-run setup when `davecode` starts: the wordmark, a theme choice (dark, light or
  match the terminal), sign-in to a DaveCode account, then the first agent (Claude Code, Codex
  or Gemini CLI) with its official login and a model. Later runs only ask to sign in again.
- DaveCode accounts: `davecode login|logout|account` and `/login`, `/logout`, `/account` in the
  chat. Sign-in happens in the browser (Google, GitHub or email, including account creation)
  through a one-shot loopback server with PKCE; the session is stored encrypted with the
  keyring master key and refreshed before it expires. The service is
  `packages/auth-worker`, a Cloudflare Worker with D1 at `auth.davecode.app`
  (override with `DAVECODE_ACCOUNT_URL`). The sign-in page only offers enabled methods.
- Antigravity (`antigravity-cli`): drives Google Antigravity's `agy` headless mode. First run
  offers Claude Code, Codex and Antigravity, with Antigravity's models read from `agy models`.
- The bird logo in the terminal, the sign-in page, the dashboard, favicons and desktop icons,
  from masters in `assets/brand/`. The UI is monochrome: no orange accent.
- Numbered menus: pressing an option's number picks it.
- First npm publication: `@dmrlzz/davecode@0.3.0`.
  Install with `npm install -g @dmrlzz/davecode`. The command remains
  `davecode`; npm rejected the unscoped package name for similarity to an existing package.
- Goal mode: `davecode goal "<objective>"` (`--dry-run`, `--max-rounds`, `--max-tasks`,
  `--max-tokens`), `davecode goals list|show|cancel`, `GET/POST /api/goals`,
  `GET /api/goals/:id`, `POST /api/goals/:id/cancel`, `goal.updated` / `goal.log` events and a
  Goals view in the dashboard with a live agent log (simulated in mock mode). A planner turns the
  objective into role-based tasks (zod-validated JSON), `artifact` tasks write markdown to
  `.davecode/goals/<goal-id>/`, `code` tasks run through the autonomous runner, and a reviewer
  re-plans. Bounded by `goal.maxRounds`, `maxTasks`, `maxTokens` and `maxTaskAttempts`.
  Outbound actions (email, posting, payments, sign-ups, deployments) are always turned into
  drafts for a human.
- Workspace lock shared by the runner and goal mode so they never edit the tree at the same time.
- Subscription details per account (`Account.subscription`: plan, price, paid and renewal dates),
  entered by hand with `davecode accounts plan <id>` or the dashboard; DaveCode never reads billing
  pages.
- Provider-reported limits: rate-limit headers and "usage limit reached… resets at" errors are
  captured, and accounts reported as exhausted are skipped until the reset time.
- Budget: `GET /api/budget`, `davecode budget [--context]` and a dashboard budget panel showing
  the remaining share of each account's tightest limit, renewal countdowns and availability. The
  compact budget summary is added to runner and goal agent prompts.
- `gemini-cli` provider: the official Gemini CLI with "Login with Google", isolated per account
  through `GEMINI_CLI_HOME`.
- Connect subscription: `davecode accounts connect <id> [--check]`,
  `GET /api/accounts/:id/connection`, `POST /api/accounts/:id/connect` and a connection panel
  with a **Connect subscription** button in the dashboard's account sheet. It runs the vendor's
  official sign-in (`claude auth login`, `codex login`, Gemini CLI) inside the account sandbox;
  DaveCode never sees the password or the tokens. On a loopback gateway the button opens a
  terminal on that machine (`davecode accounts login <id> --hold`); otherwise it shows the command.
  Connection status comes from the vendor CLI's status command and never includes credentials.
- `davecode doctor` checks for the Gemini CLI.

### Changed

- `davecode accounts login` runs `claude auth login` for Claude Code accounts (was the
  interactive `claude` session) and prints the connection status afterwards.
- Chat TUI: `/` opens a command menu navigated with ↑/↓ (Enter runs, Tab fills, Esc closes).
  The banner shows only the version and project folder; the status line no longer prints the
  gateway URL, port or a zero failover count, and reports the connection only when unhealthy.
- The terminal theme is monochrome: emphasis is bold text instead of a teal accent.

### Fixed

- The Windows installer shipped the bundled gateway without its `node_modules`
  (electron-builder drops them from `extraResources`), so opening a project failed. They are
  now copied in after packing, and the packaged acceptance check covers it.

- Gemini CLI eligibility failures (`IneligibleTierError` / `UNSUPPORTED_CLIENT`) now map to
  an actionable `auth` provider error. Live Codex and Claude adapter verification is recorded
  in `docs/PROVIDER-VERIFICATION.md`; Gemini's backend rejected CLI 0.65.0 after Google login.
- The dashboard's add-account sheet stored the CLI binary override as `config.binary`; it now
  uses `config.binaryPath`, which the adapters read.

### Known limitations

- Google Antigravity has an official CLI, but DaveCode has no adapter for it yet. Never reuse
  IDE OAuth tokens.
- Claude Code on Windows and Linux can fall back to the global `~/.claude` login, so those
  accounts are not isolated; the connection check reports it.
- Gemini CLI 0.65.0 was tested against a real install. Google sign-in succeeded, but the
  backend rejected it with `UNSUPPORTED_CLIENT`; successful live completion remains pending.

## [0.2.0] - 2026-10-06

First version validated end to end against a real (local, free) model: the autonomous runner
implemented, tested and merged a task on its own with `qwen3:8b` through Ollama.

### Added

- `davecode` is a standalone npm package: `@davecode/core` and `@davecode/server` are bundled in
  and the dashboard ships inside `dist/dashboard`.

- Dashboard: New task and edit sheets (dependency multi-select that cannot pick the task itself or
  create a cycle), status actions (Start, Mark done, Mark failed, Reopen), Run now, confirmed delete,
  and a Routes editor (add, remove, rename, reorder targets, pin accounts, default route). Both work
  in mock mode.
- `PUT /api/routes`: replace the route list and default route. Persisted to the global
  `config.json` (other keys preserved, atomic, locked) and applied to the live engine config
  immediately (`Engine.updateRouting`, `writeGlobalRouting`).
- Task graph editing: `POST /api/tasks`, `PATCH /api/tasks/:id` and `DELETE /api/tasks/:id`
  through `ProjectBrain` (lock, validation, cycle paths in the `cycle` error, status
  transitions, `has_dependents` refusal), the `task.removed` event, optional write methods on
  `BrainSource` (`501 brain_read_only` without them) and `ProjectBrain.createTask/removeTask`.
- Targeted runs: `runOnce({ taskId })` and `start({ taskId })` on the autonomous runner,
  `davecode run --task <id>` (replacing the "can only confirm the runner's pick" check) and an
  optional `{ "taskId" }` body on `POST /api/runner/start`. A task that cannot run is refused with
  `task_not_found` (404), `task_not_runnable` or `task_blocked` (409, naming the dependencies).

### Fixed

- Client cancellations (closed connection, Esc in the TUI) no longer put the account in cooldown;
  they are recorded with the new `cancelled` usage status.
- The builtin executor rejects a `finish` without any file written (once per pass) and logs why
  a tool call failed.
- `run_command` accepts a whole command line such as `node --test` in `command`.
- `write_file`/`edit_file` repair double-escaped newlines sent by small models.
- `/api/runner/*` forwards `RunnerError` codes in 409 responses.

## [0.1.0] - 2026-10-06

First release: every phase of the [specification](docs/SPEC.md) is implemented.

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
- `davecode` CLI (commander, lazy-loaded commands): `start` (gateway, dashboard, project brain
  and autonomous runner, with a compact banner, live activity log and clean SIGINT/SIGTERM
  shutdown), `status` (live from `/api/*` or local state, 1m/5h/24h quota bars), `accounts
  list|add|remove|enable|disable|login` plus `add-account` (interactive Ink prompts with masked
  secrets or a flag form for scripts; gemini-web and multi-account rotation gated behind their
  experimental flags with the ToS warning; `login` runs the real `claude`/`codex` in the
  account's isolated config dir), `init` (brain scaffold and `runner.validate` detected from
  package.json), `tasks list|next|add|status`, `config path|show|get` (secrets redacted),
  `doctor` (environment checks with fixes) and `run [--once] [--task <id>]`. Global `--home`,
  `--json`, `--no-color`/`NO_COLOR` and `--version`.
- Chat TUI (`davecode chat`, or bare `davecode` in a terminal) built with Ink 8: streaming
  replies over SSE, multiline input, slash commands (`/model`, `/route`, `/accounts`, `/tasks`,
  `/status`, `/clear`, `/help`, `/exit`), Esc to cancel, Ctrl+C twice to exit and a status line
  with the serving account, failovers, tokens and 5 h quota; starts an in-process gateway when
  none is running.
- Live runner view for `davecode run`: state-machine position, current task, repair cycle
  x/max and a log tail, fed by the in-process event bus or a running gateway's `/api/events`.

[Unreleased]: https://github.com/DMRLZZ/DaveCode/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/DMRLZZ/DaveCode/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/DMRLZZ/DaveCode/releases/tag/v0.1.0
