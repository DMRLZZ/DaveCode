# DaveCode: project state

_Last updated: 2026-10-24_

## Current focus

**Workspace v0.1 Preview on `main`**: goal mode, per-account plans and budget,
official vendor login flows, a conversational workspace and the public landing.
Next up: verify official agent sessions against real installs, finish desktop onboarding
and package an independent desktop installer. The preview tarball is available on GitHub;
engine 0.3.0 is published on npm as `@dmrlzz/davecode` (the unscoped name was rejected by
npm for similarity to `dave-code`). npm completed automated validation and the registry's
`latest` tag resolves to 0.3.0. The installed command remains `davecode`.

Workspace direction: local, outcome-oriented UI inspired by Warp's public behavior.
The default screen now composes real goals with a plan-only default, usage limits,
configured tools and live goal details. See `docs/WORKSPACE.md` for research, gaps
and the implementation sequence. Embedded terminals and native agent sessions remain pending.

Workspace v0.1 Preview now has a conversational shell, a curated Creative library,
optional Google/GitHub OAuth with an owner allowlist, and `davecode app` for a
Chrome/Edge app window. The published preview contains engine 0.2.0; the working tree is
published as engine 0.3.0 on npm.
OAuth has mocked protocol/security coverage; live provider client setup is pending.
Design defaults reject decorative dots, uppercase eyebrow labels and redundant UI copy.

The public landing is deployed through Sites at https://davecode-app.mor4lez.chatgpt.site.
`davecode.app` DNS is configured in Cloudflare; Sites confirms hostname and SSL active.
Site identity lives in `site/.openai/hosting.json`. Workspace preview release:
`workspace-v0.1.0-preview.1` (engine artifact `davecode-0.2.0.tgz`). The tarball was
installed in an isolated temp directory and its CLI help was verified.

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
  running against real local models (cancellations, empty finishes, double-escaped edits).
- **Goal mode** (unreleased): planner/reviewer roles with zod JSON contracts, artifact tasks
  through the router, code tasks through the runner, shared workspace lock, outbound-action
  guard, `davecode goal|goals`, `/api/goals`, dashboard Goals view.
- **Plans and budget** (unreleased): `Account.subscription`, provider-reported limits (headers
  and "resets at" errors) with routing around exhausted accounts, `BudgetSnapshot`,
  `davecode budget`, `davecode accounts plan`, budget context in agent prompts, dashboard panel.
- **Connect subscription** (unreleased): `gemini-cli` provider, `ConnectionChecker`, official
  login specs, `davecode accounts connect`, `/api/accounts/:id/connection|connect`, loopback-only
  terminal launcher, dashboard connection panel.

## Blockers

None.

## Known limitations

- npm installation uses `npm install -g @dmrlzz/davecode`; the unscoped name is unavailable.
- Small local models were unreliable in earlier execution tests. Onboarding now recommends
  hosted providers; use a capable model for code execution.
- Codex CLI 0.163.0 and Claude Code 2.1.309 passed live adapter completion checks on Windows.
- Gemini CLI 0.65.0 was installed in a temporary directory and completed official Google
  OAuth in an isolated home. Code Assist rejected the client with `UNSUPPORTED_CLIENT`;
  successful live completion and stream parsing remain unverified. See
  `docs/PROVIDER-VERIFICATION.md` for evidence and the offline regression test.
- Claude Code on Windows (and likely Linux) reports the global `~/.claude` login even with an
  empty `CLAUDE_CONFIG_DIR`, so per-account isolation is not effective there; the connection
  check says so.
- Google now documents an official Antigravity CLI. Local `agy` 1.4.5 version/help and
  its user PATH entry are verified; authentication and a DaveCode adapter remain pending.
  Use official authentication, never IDE token reuse.
- The dashboard's Connect button can only open a terminal when the gateway is bound to loopback;
  remote gateways get the command to run instead.
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
| 2026-10-15 | Goal mode never performs outbound actions; such tasks become draft artifacts (deterministic guard) |
| 2026-10-15 | Subscription details are entered by hand; DaveCode never scrapes billing pages |
| 2026-10-15 | Subscriptions connect only through the vendor CLI's official login; no passwords, no token reuse, no Antigravity |
| 2026-10-15 | The gateway's Connect endpoint delegates to an injected launcher, only on loopback binds |

## Activity log

- 2026-10-06: v0.1.0 release prepared; task graph updated through `davecode tasks status`.
- 2026-10-06: v0.1.0 tagged and published as a GitHub release.
- 2026-10-06: first autonomous success on a free local model (qwen3:8b); v0.2.0 released.
- 2026-10-15: goal mode, plans/budget and Connect subscription implemented on
  `feat/goal-mode-subscriptions` (not merged).
- 2026-10-22: workspace preview published from main; landing active at `davecode.app`,
  preview tarball installation verified, and release CI passed on Linux, macOS and Windows.
