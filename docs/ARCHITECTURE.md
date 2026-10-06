# Architecture

DaveCode is a **local-first** engine with two jobs:

1. **Gateway**: an OpenAI-compatible proxy (`/v1`) that routes every request to the best
   available account across providers, tracks quotas in sliding windows and fails over on
   `429`/`5xx` before the client ever notices.
2. **Autonomous engineer**: a runner that walks a task DAG, implements each task on an isolated
   git branch, validates it with your linters/tests (plus an optional judge), self-repairs up to
   three times and merges.

Everything runs on your machine. State lives in `~/.davecode` (global) and `<repo>/.davecode`
(per project).

```mermaid
flowchart TB
  subgraph Clients
    SDK[OpenAI SDKs / editors / agents]
    TUI[davecode TUI]
    WEB[Web dashboard]
  end

  subgraph Gateway["@davecode/server :4040"]
    V1["/v1 OpenAI-compatible"]
    API["/api REST + SSE"]
  end

  subgraph Core["@davecode/core"]
    ROUTER[Router + circuit breaker]
    QUOTA[Sliding-window quota engine]
    ID[Identity: sandboxes, keyring, Chromium profiles]
    BRAIN[Dual brain: global + project]
    RUNNER[Autonomous runner]
    BUS[(EventBus)]
    DB[(SQLite WAL state.db)]
  end

  subgraph Providers
    ANT[Anthropic API]
    OAI[OpenAI API]
    GEM[Gemini API]
    OC[OpenAI-compatible: OpenRouter, Ollama, LM Studio…]
    CC[Claude Code CLI]
    CX[Codex CLI]
    GW[Gemini web, experimental]
  end

  SDK --> V1
  TUI --> V1
  TUI --> API
  WEB --> API
  V1 --> ROUTER
  API --> RUNNER
  API --> BUS
  RUNNER --> BRAIN
  RUNNER --> ROUTER
  ROUTER --> QUOTA
  ROUTER --> ID
  QUOTA --> DB
  ID --> DB
  ROUTER --> ANT & OAI & GEM & OC & CC & CX & GW
  ROUTER --> BUS
  RUNNER --> BUS
```

## Packages

| Package | Responsibility |
| :------ | :------------- |
| [`@davecode/core`](../packages/core) | Domain contracts, config, SQLite storage, keyring, sandboxes, quota engine, providers, router, dual brain, task graph, autonomous runner |
| [`@davecode/server`](../packages/server) | Fastify gateway: `/v1` proxy, `/api` REST, SSE event stream, serves the built dashboard |
| [`davecode`](../packages/cli) | The published CLI (`davecode start`, `status`, `add-account`, `run`) and the Ink-based TUI |
| [`@davecode/ui`](../packages/ui) | Vite + React + Tailwind dashboard (dark by default) |

Dependency direction is strictly `cli → server → core` and `ui → (HTTP) → server`. `core`
never imports from the other packages.

### `@davecode/core` layout

```
src/
├── types.ts            # shared contracts (source of truth for docs/API.md)
├── errors.ts           # ProviderError + failover classification
├── events.ts           # typed EventBus with replay buffer
├── paths.ts            # ~/.davecode and <repo>/.davecode layout
├── config/             # zod schema + layered loader
├── storage/            # better-sqlite3 (WAL), migrations, repositories
├── identity/           # sandbox.ts, keyring.ts, chromium.ts
├── rate-limiter/       # window.ts (sliding windows), tracker.ts (SQLite-backed)
├── providers/          # one adapter per ProviderKind
├── router/             # account selection, balancing, hot failover, circuit breaker
├── brain/              # global.ts, project.ts, graph.ts (DAG resolver)
└── autonomous/         # runner.ts, executor.ts, validator.ts, git.ts, judge.ts
```

## Key design decisions

| Decision | Choice | Why |
| :------- | :----- | :-- |
| Runtime | Node.js ≥ 22.12, ESM | Widest contributor reach; Node 20 is EOL |
| Repo | pnpm workspaces monorepo | Clear package boundaries, one lockfile |
| Storage | SQLite (WAL) via `better-sqlite3` | Synchronous, fast, multi-process safe, zero ops |
| Secrets | AES-256-GCM, per-install master key in `~/.davecode/master.key` (0600) | Encryption at rest without an external KMS |
| Validation | zod | One schema for config, API bodies and task graphs |
| Token counting | `js-tiktoken` (pure JS) | No native build; good-enough estimates when upstream omits usage |
| Gateway | Fastify 5 | Fast, typed, first-class streaming |
| Live updates | Server-Sent Events | One-way stream is all the dashboard needs, proxies well |
| UI | TUI (Ink) + web dashboard (Vite/React/Tailwind) | Terminal-first like Claude Code/opencode, rich observability in the browser |
| Judge | Deterministic checks by default; optional TypeSafe Jev or any LLM route | Free by default, calibrated confidence when you want it |

## Routing & quotas

Each account is tracked in four sliding windows: **TPM** and **RPM** (60 s), **5 h** and
**24 h**. Selection for a request:

1. Resolve the candidate list from the route (`davecode/auto`), provider prefix or bare model.
2. Drop accounts that are disabled, cooling down, or whose window would overflow.
3. Score the rest: priority first, then weight × headroom. Above **85 %** utilization an account's
   weight is smoothly reduced (backpressure); above **90 %** of its 5 h quota traffic shifts to
   alternates.
4. Call the provider. On `rate_limit`, `quota_exhausted`, `unavailable`, `timeout`, `network`
   or `context_length`, put the account in cooldown (honouring `Retry-After`), emit
   `router.failover` and immediately try the next candidate, up to `routing.maxFailovers`.

Subscription providers (`claude-cli`, `codex-cli`, `gemini-web`) only rotate across multiple
accounts of the same provider when `experimental.multiAccountRotation` is enabled.

## Identity isolation

- **CLI providers**: each account gets `~/.davecode/sandboxes/<accountId>/`, passed to the child
  process as `CLAUDE_CONFIG_DIR` (Claude Code) or `CODEX_HOME` (Codex). Accounts never share
  credentials, caches or rate-limit state.
- **Browser providers** (experimental): a dedicated Chromium `userDataDir` under
  `~/.davecode/profiles/<accountId>/`. `playwright-core` is an optional peer dependency.
- **Secrets**: stored in the `secrets` table encrypted with AES-256-GCM. Secrets are write-only
  through the API and never appear in events or logs.

## Dual brain

```
~/.davecode/brain/          GLOBAL USER BRAIN: preferences, coding patterns (markdown)
<repo>/.davecode/
├── STATE.md                current progress, blockers
├── ARCHITECTURE.md         system patterns, dependencies, stack
└── TASK_GRAPH.json         DAG of tasks: PENDING | IN_PROGRESS | SUCCESS | FAILED
```

The task graph is validated on read and on write (`parseTaskGraph`): duplicate ids, unknown
dependencies, self-dependencies and cycles are rejected, and cycle errors name the path
(`a → b → c → a`). The next task is the highest-priority `PENDING` node whose dependencies are
all `SUCCESS`; ties keep file order. Status changes are immutable updates that follow
`PENDING → IN_PROGRESS → SUCCESS | FAILED | PENDING`, `FAILED → PENDING` (retry) and
`SUCCESS → PENDING` (reopen); entering `IN_PROGRESS` increments `attempts`.

Module map (`packages/core/src/brain/`):

| Module | Responsibility |
| :----- | :------------- |
| `graph.ts` | zod schema, DAG validation, `nextTask`/`readyTasks`/`blockedTasks`, `summarize`, `updateTask`/`setTaskStatus` |
| `project.ts` | `ProjectBrain`: scaffold, read/write STATE.md, ARCHITECTURE.md and the graph, `task.updated` events |
| `markdown.ts` | level-2 section parser behind `updateStateSection` and `appendStateLog` (fence-aware, preserves other content) |
| `lock.ts` | `.davecode/.lock` (`{ pid, ts }`, stale after 30 s) serialising read-modify-write cycles between the runner and the dashboard |
| `global.ts` | `GlobalBrain`: flat markdown notes in `~/.davecode/brain/`, names sanitised, no path traversal |
| `context.ts` | `buildTaskContext` and `DAVECODE_SYSTEM_PROMPT` |

All writes are atomic (temp file + rename). `buildTaskContext` emits, in order, `GLOBAL BRAIN`,
`PROJECT ARCHITECTURE`, `PROJECT STATE` and `CURRENT TASK` sections. Over budget (default
60 000 characters) it cuts the least important material first: global notes, then the oldest
STATE.md activity-log entries, then the rest of STATE.md, and ARCHITECTURE.md only as a last
resort. Every cut is marked `[… truncated to fit the context budget]` and the task section is
never truncated. Add `.davecode/.lock` to a project's `.gitignore`.

## Autonomous loop

```mermaid
stateDiagram-v2
  [*] --> idle
  idle --> selecting: start
  selecting --> preparing: unblocked task
  selecting --> idle: nothing to do
  preparing --> implementing: branch davecode/task-<id>
  implementing --> validating
  validating --> merging: lint + typecheck + tests + judge pass
  validating --> repairing: failure (cycle < 3)
  repairing --> implementing: inject stderr/stdout
  validating --> selecting: failure (cycle = 3), task FAILED
  merging --> selecting: task SUCCESS, STATE.md updated
```

## Experimental & Terms-of-Service-sensitive features

Two capabilities described in the [original specification](SPEC.md) automate consumer
products in ways their providers may prohibit. They ship **disabled** and require an explicit
opt-in in `config.json`:

| Flag | Enables | Risk |
| :--- | :------ | :--- |
| `experimental.geminiWeb` | The `gemini-web` provider (Chromium-driven Gemini web session) | Likely violates Google's ToS; accounts can be suspended |
| `experimental.multiAccountRotation` | Balancing across several subscription logins of one provider | May violate Anthropic/OpenAI consumer terms; accounts can be suspended |

API-key providers and cross-provider failover are unaffected by these flags.
