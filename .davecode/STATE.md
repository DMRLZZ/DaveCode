# DaveCode: project state

_Last updated: 2026-10-31_

## Current focus

**v0.5.1 on `main`**: real terminal panes in the desktop app, plus the monochrome terminal and desktop workspace with the bird mark, first-run
setup, DaveCode accounts on Cloudflare (`davecode-auth` + D1 at `auth.davecode.app`),
official vendor sign-in for Claude Code, Codex and Antigravity (`agy`), desktop installers
for Windows, macOS and Linux, and the public site at `davecode.app` served from the
`davecode-site` Cloudflare Worker. The CLI is published on npm as `@dmrlzz/davecode@0.5.1`
(installed command `davecode`).

## In progress

- Optional code-signing certificates for the Windows and macOS desktop installers.
- Orchestrator on top of the desktop panes (today: one message broadcast to every agent pane).

## Done

- **Foundation** (#1): pnpm monorepo, strict TypeScript, Biome, Vitest, tsup, CI on
  Linux/macOS/Windows, shared contracts, config schema, OSS docs.
- **Phase 1** (#9): layered config loader, SQLite (WAL) storage, AES-256-GCM keyring,
  per-account sandboxes, Chromium profiles.
- **Phase 2** (#7, #10): provider adapters, sliding-window quota engine, hot-failover
  router with circuit breaker, OpenAI-compatible gateway with dashboard API and SSE.
- **Phase 3** (#6): task graph DAG resolver, project and global brains, task context builder.
- **Phase 4** (#13): autonomous runner with builtin and claude-cli executors, validator,
  repair cycles, git flow and optional judge (none / TypeSafe Jev / LLM).
- **Phase 5** (#11, #14): web dashboard and the `davecode` CLI with the chat TUI and runner view.
- **Contract hardening** (#12): SSE ids with `Last-Event-ID` resume, `Account.hasSecret`.
- **v0.2.0** (#16–#18): standalone package, task/route editing, targeted runs, and fixes found by
  running against real local models (cancellations, empty finishes, double-escaped edits).
- **v0.3.0 / Workspace Preview**: goal mode, per-account subscription plans and budget,
  `ConnectionChecker` and official vendor CLI login flows, conversational workspace UI, and
  first npm publication (`@dmrlzz/davecode`).
- **v0.4.0** (#35–#46): bird logo and monochrome design system across terminal, web and desktop;
  Antigravity (`antigravity-cli` via `agy`) adapter and first-run onboarding; DaveCode accounts
  on Cloudflare Workers + D1 (`packages/auth-worker`); `/connect`, `/model` and `/status` pickers
  in the chat TUI; Windows, macOS and Linux desktop installers in GitHub Releases; npm Trusted
  Publishing; and `davecode.app` hosted on Cloudflare Workers (`site/`).

- **Desktop terminals**: real PTY panes (`@lydell/node-pty` + xterm.js) for a shell, Claude Code,
  Codex, Antigravity and DaveCode; the desktop opens on them and reopens the last project.

## Blockers

None.

## Known limitations

- Desktop panes use the vendor CLIs' global logins, not DaveCode's per-account sandboxes.

- npm installation uses `npm install -g @dmrlzz/davecode`; the unscoped name is unavailable.
- Desktop installers are unsigned preview builds (Windows SmartScreen / macOS Gatekeeper require
  confirming first launch).
- Codex CLI, Claude Code and Antigravity (`agy`) passed live adapter completion checks on Windows.
- Gemini CLI 0.65.0 completed official Google OAuth in an isolated home, but Code Assist rejected
  the client with `UNSUPPORTED_CLIENT`. Use `antigravity-cli` (`agy`) or a Gemini API key instead.
- Claude Code on Windows and Linux can fall back to the global `~/.claude` login even with
  `CLAUDE_CONFIG_DIR` set; the connection check reports that case.
- The dashboard's Connect button can only open a terminal when the gateway is bound to loopback;
  remote gateways get the command to run instead.

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
- 2026-10-29: v0.4.0 released (`@dmrlzz/davecode@0.4.0` on npm, desktop installers on GitHub
  Releases, `davecode-auth` and `davecode-site` deployed on Cloudflare Workers).
- 2026-11-05: v0.5.1 prepared with the security fixes from #53–#56; the `davecode-auth` migration
  and worker went live first.
