<div align="center">

<img src="docs/brand/davecode.svg" alt="DaveCode" width="720" />

# DaveCode v0.1 Preview

**Your ideas. Your AI tools. One open-source workspace.**

One OpenAI-compatible endpoint in front of Claude, GPT, Gemini and your local models, with
quota-aware routing and hot failover, plus an engine that turns a task graph into tested,
merged code while you sleep.

[![CI](https://github.com/DMRLZZ/DaveCode/actions/workflows/ci.yml/badge.svg)](https://github.com/DMRLZZ/DaveCode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22.12-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Status](https://img.shields.io/badge/status-alpha-orange)

</div>

---

> [!WARNING]
> DaveCode is in **early development**. APIs and config may change between minor versions until
> `1.0`. See the [roadmap](#roadmap) for what already works.

## Why DaveCode?

You pay for several AI tools, and you still hit `429 Too Many Requests` in the middle of a
refactor, copy context between chat windows, and babysit agents that declare victory before the
tests pass. DaveCode fixes the plumbing:

- **One endpoint, every model.** Point any OpenAI SDK, editor or agent at
  `http://localhost:4040/v1` and use `davecode/auto`.
- **Never stall on a rate limit.** Sliding-window quota tracking (TPM, RPM, 5 h, 24 h) per
  account, smooth backpressure at 85 %, and hot failover to the next account or provider when an
  upstream returns `429`/`5xx`.
- **Isolated identities.** Each Claude Code / Codex account runs in its own sandboxed config
  directory; secrets are AES-256-GCM encrypted at rest and never leave your machine.
- **A brain that persists.** A global brain for your preferences plus a per-repo brain
  (`STATE.md`, `ARCHITECTURE.md`, `TASK_GRAPH.json`) injected into every task.
- **Autonomous, but accountable.** Each task runs on its own `davecode/task-<id>` branch and is only
  merged after your linters and tests pass, with up to three self-repair cycles. An optional
  judge ([TypeSafe Jev](https://www.llmreference.com/provider/typesafe-ai/jev) or any of your
  routes) checks acceptance criteria with calibrated confidence. The default is free,
  deterministic checks.
- **Terminal-first, with a cockpit.** A TUI in the spirit of Claude Code and opencode, plus a
  real-time web dashboard for token burn, failovers and task traces.

## How it works

```mermaid
flowchart LR
  C[Your tools<br/>SDKs · editors · agents] -->|OpenAI API| G[DaveCode gateway<br/>:4040]
  T[TUI] --> G
  D[Dashboard] -->|REST + SSE| G
  G --> R{Router<br/>quotas + failover}
  R --> A[Anthropic]
  R --> O[OpenAI]
  R --> M[Gemini]
  R --> L[OpenRouter / compatible endpoints]
  R --> CC[Claude Code CLI]
  R --> CX[Codex CLI]
  G --> E[Autonomous runner]
  E --> B[(Project brain<br/>.davecode/)]
```

Read the full design in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the HTTP contract in
[docs/API.md](docs/API.md).

## Quick start

Install the **Workspace v0.1 Preview** with Node.js 22.12+ and npm:

```bash
npm install -g https://github.com/DMRLZZ/DaveCode/releases/download/workspace-v0.1.0-preview.1/davecode-0.2.0.tgz
```

Run `davecode app` for the local app window, or `davecode` for the terminal.
The package contains engine 0.2.0; this preview does not replace historical releases.

### Build from source

> Requires **Node.js 22.12+**. The `davecode` package is standalone: it bundles the engine, the
> gateway and the dashboard. Until it is published to npm, install it from a release tarball or
> from source.

```bash
git clone https://github.com/DMRLZZ/DaveCode.git
cd DaveCode
pnpm install
pnpm build
cd packages/cli && pnpm pack && npm install -g ./davecode-*.tgz   # puts `davecode` on your PATH
```

### Connect your AI tools

Use official Claude, Codex or Gemini login, or an API provider such as OpenRouter.
DaveCode adds no subscription; provider plans and usage charges still apply.

Run `davecode` for the terminal, or `davecode app` for a Chrome/Edge app window.
Keep the gateway process running while you work. Native packaging is still pending.

The workspace is **v0.1 Preview**. The engine/package line remains **0.2.x**;
historical releases and Git tags are preserved.

Optional [Google/GitHub sign-in](docs/AUTH.md) is separate from AI connections.
The Creative library prepares design briefs using curated references.

`pnpm build` also builds the CLI. Put `davecode` on your PATH (or run
`node packages/cli/bin/davecode.js`; `pnpm --filter davecode dev <command>` runs from source):

```bash
alias davecode="node $PWD/packages/cli/bin/davecode.js"   # or: cd packages/cli && npm link

davecode doctor                     # checks Node, SQLite, ports and supported CLI tools
davecode accounts add               # interactive: provider, label, priority, masked API key
davecode start                      # gateway on :4040 + dashboard at http://localhost:4040/
davecode status                     # health, accounts and 1m/5h/24h quota bars (--json too)
davecode                            # chat TUI in your terminal (same as `davecode chat`)
```

Scripts can skip the prompts:

```bash
davecode accounts add --provider anthropic --label work --secret-env ANTHROPIC_API_KEY --yes
davecode accounts add --provider openai-compatible --label OpenRouter \
  --base-url https://openrouter.ai/api/v1 --model openrouter/auto --secret-env OPENROUTER_API_KEY --yes
davecode accounts add --provider claude-cli --label "Claude Pro" --yes
davecode accounts connect <id>      # official sign-in (claude auth login) in the account sandbox
```

### Connect a subscription

Subscription accounts (`claude-cli`, `codex-cli`, `gemini-cli`) are signed in by the vendor's own
CLI, never by DaveCode: there is no password field anywhere, and the resulting tokens stay in the
vendor CLI's store inside the account's sandbox (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
`GEMINI_CLI_HOME`). API keys go to the AES-256-GCM keyring.

```bash
davecode accounts connect <id> --check   # connected / not connected, without touching anything
davecode accounts connect <id>           # runs the official login if needed
davecode accounts login <id> -- login --device-auth   # pass your own arguments (Codex device code)
```

In the dashboard, the account sheet shows the connection status and a **Connect subscription**
button. When the gateway is bound to `127.0.0.1` it opens a terminal window on that machine with
the official login and the page updates once it lands; on any other bind address it shows the
command to run instead.

### Plans and remaining budget

Record what each account costs and when it renews (entered by hand; DaveCode never reads billing
pages), then see what is left:

```bash
davecode accounts plan <id> --plan "Claude Pro" --price 20 --renews 2026-11-01
davecode budget                     # plan, renewal, remaining share of the tightest limit
davecode budget --context           # the compact summary agents receive in their prompts
```

Remaining budget combines DaveCode's own sliding windows with the limits providers report
(rate-limit headers, "usage limit reached… resets at" errors). Accounts a provider reported as
exhausted are skipped by the router until the reset time.

### Work on a repository

Point DaveCode at a repository and let it work through the task graph:

```bash
cd ~/code/my-app
davecode init                       # .davecode/ brain + runner.validate from package.json
davecode tasks add api "Add the /health endpoint" --acceptance "GET /health returns 200"
davecode tasks                      # task tree with status glyphs and blocked reasons
davecode run --once                 # implement the next task, validate, repair, merge
davecode run                        # 24/7 loop with a live runner view; Ctrl+C stops safely
davecode run --task api --once      # run one specific task (must be PENDING and unblocked)
```

Or give it an objective and let a team of agents plan, execute, review and re-plan:

```bash
davecode goal "Write positioning and landing copy for this app" --dry-run   # plan only
davecode goal "Add a /health endpoint with tests" --max-rounds 2
davecode goals                      # list; `goals show <id>`, `goals cancel <id>`
```

Goal mode is bounded by rounds, a task cap and a token budget (`goal.*` config). Code tasks go
through the autonomous runner (branch, checks, merge); research and writing tasks produce
markdown under `.davecode/goals/<goal-id>/`. Agents never send email, post, pay or sign up for
anything: those steps become drafts for you to review.

Other commands: `davecode config show|path|get <key>` (secrets redacted), `davecode tasks next`,
`davecode tasks status <id> <STATUS>`, `davecode accounts list|enable|disable|remove|plan|login|connect`. Global
flags: `--home <dir>` (sets `DAVECODE_HOME`), `--json`, `--no-color` (and `NO_COLOR`).

In the chat TUI, Enter sends, Shift+Enter or Ctrl+J adds a line, Esc cancels a reply and
Ctrl+C twice exits. Slash commands: `/model`, `/route`, `/accounts`, `/tasks`, `/status`,
`/clear`, `/help`, `/exit`. The status line shows the model, the account that served the last
reply, failovers, tokens and the 5 h quota. Without a running gateway the TUI starts one
in-process.

Any OpenAI-compatible client works against the gateway:

```ts
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'http://localhost:4040/v1', apiKey: 'unused-locally' });

const res = await client.chat.completions.create({
  model: 'davecode/auto',
  messages: [{ role: 'user', content: 'Explain this stack trace…' }],
});
```

## Dashboard

A keyboard-first web cockpit for the gateway and the autonomous engine (`packages/ui`, Vite +
React + Tailwind). The gateway serves its production build (`packages/ui/dist`) at
`http://localhost:4040/`.

![DaveCode dashboard overview: token burn, quota utilization and recent activity](docs/assets/dashboard-overview.png)

| Task graph | Accounts |
| :--------: | :------: |
| ![Task graph as a dependency DAG with STATE.md and task details](docs/assets/dashboard-tasks.png) | ![Accounts with quota meters, cooldowns and enable toggles](docs/assets/dashboard-accounts.png) |

- **Overview**: live token burn (tokens/min over 60 min), requests/min, failovers, health and
  per-account 1m/5h/24h quota meters with the 85 % backpressure and 90 % shift thresholds.
- **Accounts, Traffic, Routes**: add accounts with write-only secrets, see each account's
  connection status and **Connect subscription** to the vendor's official sign-in, record plans
  and renewals next to the remaining budget, watch every request with its failover chain inline
  (`acc A → 429 → acc B ✓`), inspect ordered route targets.
- **Goals**: start an objective (or a dry-run plan), follow the agent team's live log, task
  board and artifacts, and cancel it.
- **Tasks and Runner**: the task graph as a DAG, board or list next to `STATE.md`, and the
  runner's state machine, repair cycles and live logs with start/pause/stop.
- `Ctrl/⌘ K` opens the command palette; `g o`, `g a`, `g t`… jump between screens; `?` lists
  every shortcut. Dark by default, with a light theme.

Develop it against a running gateway, or fully offline with simulated data:

```bash
pnpm dev:ui                     # http://localhost:5173, proxies /api and /v1 to :4040
# open http://localhost:5173/?mock=1 for mock mode (or set VITE_DAVECODE_MOCK=1)
```

When the gateway is unreachable the dashboard falls back to mock data automatically and shows a
**Mock data** badge. The screenshots above were taken in mock mode.

## Providers

| Provider | Kind | Auth | Default |
| :------- | :--- | :--- | :------ |
| Anthropic API | `anthropic` | API key | ✅ |
| OpenAI API | `openai` | API key | ✅ |
| Google Gemini API | `gemini` | API key | ✅ |
| OpenRouter and compatible endpoints | `openai-compatible` | Provider key + base URL | ✅ |
| Claude Code CLI | `claude-cli` | Your Claude login, isolated per account | ✅ |
| Codex CLI | `codex-cli` | Your ChatGPT/OpenAI login, isolated per account | ✅ |
| Gemini CLI | `gemini-cli` | Your Google login ("Login with Google"), isolated per account | ✅ |
| Gemini web session | `gemini-web` | Browser profile | ⚠️ Experimental, off |

Subscriptions are used only through the vendor's own CLI and its official sign-in. Known limits:

- **Google Antigravity is not supported.** It has no public API or CLI, and reusing its OAuth
  tokens from another program (what community plugins do) breaks Google's terms. The supported way
  to use a Google AI subscription is `gemini-cli`.
- None of Anthropic, OpenAI or Google offer an OAuth flow that lets third-party apps use a
  consumer subscription directly, so "Connect subscription" runs the vendor CLI's login rather
  than a web OAuth consent screen.
- On Windows and Linux, Claude Code may fall back to your global login (`~/.claude`) instead of
  the account sandbox. `accounts connect --check` and the dashboard say so when it happens, because
  the account is then not isolated.
- The `gemini-cli` adapter (`GEMINI_CLI_HOME` isolation and the `stream-json` output) has not been
  verified against a real Gemini CLI install yet.

### Terms of Service

DaveCode's original specification includes two capabilities that automate consumer products in
ways their providers may prohibit:

- driving a **Gemini web session** through Chromium (`experimental.geminiWeb`), and
- **rotating several subscription logins** of the same provider to get around per-account limits
  (`experimental.multiAccountRotation`).

Both are **disabled by default**. If you turn them on, you accept the risk of your accounts being
rate-limited or suspended by the provider. API-key providers and cross-provider failover are not
affected.

## Configuration

DaveCode merges built-in defaults, `~/.davecode/config.json`, `<repo>/.davecode/config.json` and
environment variables. A minimal example:

```json
{
  "routing": {
    "routes": [
      {
        "name": "auto",
        "targets": [
          { "provider": "anthropic", "model": "claude-sonnet-5-5" },
          { "provider": "openai", "model": "gpt-5.5" },
          { "provider": "openai-compatible", "model": "openrouter/auto" }
        ]
      }
    ]
  },
  "runner": {
    "validate": { "lint": "pnpm lint", "typecheck": "pnpm typecheck", "test": "pnpm test" },
    "judge": { "kind": "none" }
  }
}
```

The full schema with documentation lives in
[`packages/core/src/config/schema.ts`](packages/core/src/config/schema.ts).

## Project layout

```
packages/
├── core/     @davecode/core: contracts, storage, identity, quotas, providers, router, brain, runner
├── server/   @davecode/server: Fastify gateway (/v1 proxy, /api, SSE), serves the dashboard
├── cli/      davecode: CLI commands and the Ink TUI
└── ui/       @davecode/ui: Vite + React + Tailwind dashboard
docs/         architecture, API contract, original spec
.davecode/    DaveCode's own project brain (we dogfood it)
```

## Roadmap

- [x] **Foundation:** monorepo, shared contracts, config schema, CI
- [x] **Phase 1, gateway & identity:** SQLite storage, encrypted keyring, sandbox manager,
  OpenAI-compatible gateway
- [x] **Phase 2, quotas & router:** sliding windows, provider adapters, hot failover
- [x] **Phase 3, dual brain:** global/project brain, task graph DAG with cycle detection
- [x] **Phase 4, autonomous loop:** runner state machine, validator, repair cycles, git flow, judge
- [x] **Phase 5, interfaces:** web dashboard, CLI and TUI
- [x] **v0.1.0:** first tagged release (run from source)
- [x] Standalone `davecode` package (bundled engine, gateway and dashboard)
- [ ] Publish `davecode` to npm (`npx davecode`)
- [ ] Verified Codex CLI event format and more provider live tests
- [x] Editing routes and the task graph from the dashboard
- [x] Targeting a specific task with `davecode run --task <id>`
- [x] Goal mode: objective → agent team → plan, execute, review, re-plan
- [x] Plans, renewals and remaining budget per account, shared with agents
- [x] Connect subscription (official vendor sign-in) from the CLI and the dashboard
- [ ] Verified Gemini CLI adapter against a real install

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) to get set up, and please follow
our [Code of Conduct](CODE_OF_CONDUCT.md). Security issues go through [SECURITY.md](SECURITY.md),
not public issues.

## License

[MIT](LICENSE) © DaveCode contributors
