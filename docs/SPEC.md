# DaveCode Architecture Specification & System Prompt

> This is the founding specification of DaveCode, kept for reference. The implemented design,
> including the decisions taken where this document left options open, lives in
> [ARCHITECTURE.md](ARCHITECTURE.md). Features flagged as Terms-of-Service-sensitive ship
> disabled by default. See the "Experimental" section there.

## 1. Executive Summary & Mission Statement

### Executive Summary

**DaveCode** is a local-first, autonomous software engineering engine and intelligent AI routing
gateway. It unifies disparate frontier language model ecosystems (specifically Claude Code CLI,
Google Antigravity/Gemini active sessions, and Codex/OpenAI endpoints) into a singular,
fault-tolerant execution layer. DaveCode functions simultaneously as a local HTTP/WebSocket proxy
and a headless autonomous agent orchestration engine, giving developers continuous, quota-aware
execution without manual model switching or session maintenance.

### Mission Statement

To eliminate token context decay, model quota lockouts, and multi-account fragmentation by
providing a local, self-healing, multi-session intelligence network that converts high-level user
intents into tested, validated production code 24 hours a day, 7 days a week.

```
                  +---------------------------------------------------+
                  |            DaveCode Orchestrator Engine           |
                  +---------------------------------------------------+
                                            |
         +----------------------------------+----------------------------------+
         |                                  |                                  |
         v                                  v                                  v
+------------------+              +------------------+              +------------------+
|  Claude Code CLI |              | Google Gemini    |              | Codex / OpenAI   |
|  (Multi-Account) |              | (Browser Sync)   |              | (Direct API)     |
+------------------+              +------------------+              +------------------+
         |                                  |                                  |
  CLAUDE_CONFIG_DIR                 Chromium Profiles                 Session Key Ring
  isolation & sandbox           cookie/session persistence         rate-limit tracking
```

## 2. Architectural Requirements & Capabilities

### 2.1 Isolated Multi-Session Identity Manager

To bypass single-account throttling and enforce strict data safety, DaveCode implements an
Anti-Collision Identity Engine:

- **Directory Sandboxing:** Each managed identity maintains an isolated environment directory.
  For Claude Code CLI, DaveCode dynamically manages the `CLAUDE_CONFIG_DIR` environment variable
  per worker thread, preventing session collisions, shared key lockouts, or rate limit
  cross-contamination.
- **Browser Profile Isolation:** For web-authenticated platforms (such as Google
  Antigravity/Gemini Web), DaveCode orchestrates headless and headful Chromium browser instances
  using distinct `userDataDir` paths (`~/.davecode/profiles/gemini_account_01`).
- **Session Persistence:** State tokens, cookies, refresh tokens, and authentication headers are
  persisted in a local SQLite database (`~/.davecode/state.db`) using AES-256-GCM encryption at
  rest.

### 2.2 Routing, Token Quotas & Sliding-Window Balancer

DaveCode handles model access using an automated token-quota and rate-limit tracking engine:

| Metric | Window Size | Strategy |
| :----- | :---------- | :------- |
| **TPM (Tokens Per Minute)** | 60-second sliding | Real-time token counting via tiktoken/tree-sitter. Smooth backpressure when approaching 85% capacity. |
| **RPM (Requests Per Minute)** | 60-second sliding | Fixed sliding bucket. Queue requests locally when threshold is reached. |
| **Tier Quotas (5-Hour)** | 300-minute sliding | Tracks rolling limit windows typical of Claude Pro/Team accounts. Shift weights to alternate accounts upon reaching 90% quota. |
| **Daily Limits (24-Hour)** | 1440-minute sliding | Long-term budget and quota tracking across all connected accounts. |

- **Hot-Failover Engine:** When an HTTP 429 (Too Many Requests), 503 (Service Unavailable), or
  context completion error occurs, DaveCode catches the error within a zero-latency circuit
  breaker. The pending prompt frame is payload-converted and hot-routed to the next
  highest-ranked available account or provider within <150ms.

### 2.3 Hierarchical Context Engine (Dual-Brain)

DaveCode decouples long-term strategic context from short-term task execution through a two-tier
context subsystem:

```
+---------------------------------------------------------------------------------+
|                                GLOBAL USER BRAIN                                |
|        (~/.davecode/brain/ -> Architectural preferences, coding patterns)       |
+---------------------------------------------------------------------------------+
                                        |
                                        v
+---------------------------------------------------------------------------------+
|                               LOCAL PROJECT BRAIN                               |
|        (.davecode/ -> Repository specific architecture, state, and tasks)       |
|                                                                                 |
|   +-----------------------+ +-----------------------+ +---------------------+   |
|   |       STATE.md        | |    ARCHITECTURE.md    | |   TASK_GRAPH.json   |   |
|   |  (Current progress,   | |   (System patterns,   | |  (DAG of pending &  |   |
|   |   blockers, state)    | |  dependencies, stack) | |   completed tasks)  |   |
|   +-----------------------+ +-----------------------+ +---------------------+   |
+---------------------------------------------------------------------------------+
```

### 2.4 24/7 Autonomous Development Loop

The autonomous execution loop follows a strict deterministic workflow:

1. **Task Selection:** Read `TASK_GRAPH.json` to find the next unblocked node.
2. **Context Injection:** Merge `GLOBAL_BRAIN`, `ARCHITECTURE.md`, and active `STATE.md`.
3. **Branch Isolation:** Spin up an ephemeral git branch (`davecode/task-<task_id>`).
4. **Implementation:** Execute edits using local LLM provider tools.
5. **Validation Loop:**
   - Run language-specific linter (e.g., `eslint`, `biome`, `clippy`).
   - Run targeted unit and integration tests.
   - If failure occurs, re-inject stdout error logs into the active session context and retry
     (up to 3 automated repair cycles).
6. **PR Generation & Merging:** Upon successful validation, compile a summary PR, update
   `STATE.md` and `TASK_GRAPH.json`, and merge into main/development branch.

## 3. System Stack & Tech Decisions

- **Core Runtime:** Node.js (v20+) or Bun runtime for high-performance async I/O.
- **Language:** TypeScript 5.x (strict mode enforced).
- **Storage Layer:** SQLite with `WAL` (Write-Ahead Logging) mode via `better-sqlite3` or
  `bun:sqlite` for high-rate event logging, token usage tracking, and multi-process safety.
- **User Interface:** Web Dashboard powered by Vite + React + Tailwind CSS (dark mode default)
  connected via Server-Sent Events (SSE) and WebSockets for real-time trace inspection.
- **Local Proxy Server:** Fastify/Express server running on `http://localhost:4040/v1` serving an
  OpenAI-compatible API spec (`/v1/chat/completions`, `/v1/models`).

## 4. File System & Module Structure

```
davecode/
├── bin/
│   └── davecode.js                 # CLI entry point
├── config/
│   └── default.json                # Default system configuration
├── src/
│   ├── index.ts                    # Main Application Bootstrap
│   ├── server/                     # Proxy & API Routing
│   │   ├── gateway.ts              # OpenAI-compatible API Server (:4040)
│   │   ├── router.ts               # Model selection & Hot-Failover
│   │   └── sse.ts                  # Real-time event streaming UI logs
│   ├── identity/                   # Multi-Session & Identity Management
│   │   ├── sandbox.ts              # CLAUDE_CONFIG_DIR & Profile Manager
│   │   ├── chromium.ts             # Playwright/Puppeteer Google Sync
│   │   └── keyring.ts              # Encrypted token persistence
│   ├── rate-limiter/               # Sliding Window Quota Engine
│   │   ├── window.ts               # TPM/RPM sliding window algorithm
│   │   └── tracker.ts              # SQLite-backed usage database
│   ├── brain/                      # Hierarchical Context Engine
│   │   ├── global.ts               # ~/.davecode Global Brain Manager
│   │   ├── project.ts              # .davecode Local Project Brain Sync
│   │   └── graph.ts                # TASK_GRAPH.json DAG resolver
│   ├── autonomous/                 # Autonomous Agent Loop
│   │   ├── runner.ts               # Main 24/7 execution loop
│   │   ├── executor.ts             # Tool execution & shell sandboxing
│   │   ├── validator.ts            # Linter & test execution harness
│   │   └── git.ts                  # Branching & PR generation wrapper
│   └── ui/                         # React Admin Dashboard (Vite App)
│       ├── src/
│       │   ├── App.tsx
│       │   └── components/
│       └── vite.config.ts
├── package.json
└── tsconfig.json
```

## 5. Implementation Plan

### Phase 1: Core Gateway & Identity Isolation Infrastructure

- **Step 1:** Initialize TypeScript project with Bun/Node, set up a Fastify proxy endpoint on port
  `4040`.
- **Step 2:** Implement SQLite database schema for `accounts`, `sessions`, `token_usage`, and
  `audit_logs`.
- **Step 3:** Build `SandboxManager` to handle isolated directory generation
  (`~/.davecode/sandboxes/<id>`) and set process env vars dynamically.

### Phase 2: Sliding-Window Quota Balancer & Router

- **Step 4:** Build the sliding-window algorithm for tracking 1-min, 5-hour, and 24-hour token
  metrics.
- **Step 5:** Implement request proxying to Claude CLI wrapper, OpenAI API, and Gemini web
  adapters.
- **Step 6:** Add automatic failover handler intercepting 429/50x responses to reroute payloads to
  secondary backends.

### Phase 3: Dual-Brain Context System

- **Step 7:** Implement parser and state machine for local `.davecode/` directory structure
  (`STATE.md`, `ARCHITECTURE.md`, `TASK_GRAPH.json`).
- **Step 8:** Implement automatic state synchronization and task graph validation (detecting
  cyclic dependencies).

### Phase 4: Autonomous Execution Loop & Quality Gates

- **Step 9:** Build `AutonomousRunner` state machine (Fetch Task -> Checkout Branch -> Apply Code
  -> Run Tests -> Commit/Merge).
- **Step 10:** Integrate dynamic retry logic catching stderr output from linting and testing
  suites.

### Phase 5: Monitoring Dashboard & CLI

- **Step 11:** Build React + Tailwind web UI showing active sessions, real-time token burn rates,
  task execution logs, and system health.
- **Step 12:** Package CLI binary (`davecode start`, `davecode status`, `davecode add-account`).

## 6. Master Prompt / System Prompt

```text
SYSTEM PROMPT: DAVECODE_AUTONOMOUS_ENGINE_V1

You are operating as DaveCode, an elite, fully autonomous multi-account AI software engineering
engine and protocol orchestrator. You are responsible for local context management, task
execution, dynamic failover orchestration, and rigorous quality assurance.

### CORE OPERATIONAL DIRECTIVES

1. STRICT ISOLATION & ACCOUNT INTEGRITY
   - Never write runtime session artifacts to global environments.
   - Respect isolated directory boundaries. Ensure all sub-process calls specify their
     designated `CLAUDE_CONFIG_DIR` or profile directory.
   - Do not leak authorization headers or state cookies across accounts.

2. DUAL-BRAIN CONTEXT MAINTENANCE
   - Before executing any modification, inspect `.davecode/STATE.md` and
     `.davecode/ARCHITECTURE.md`.
   - Update `.davecode/STATE.md` immediately upon changing execution status.
   - Mark task statuses in `.davecode/TASK_GRAPH.json` using explicit states: `PENDING`,
     `IN_PROGRESS`, `SUCCESS`, `FAILED`.

3. DETERMINISTIC TEST-DRIVEN QUALITY GATES
   - Code changes are NOT complete until linters and tests pass clean (exit code 0).
   - If a test or linter fails:
     a. Capture exact stderr and stdout logs.
     b. Diagnose root cause in context.
     c. Apply targeted repair diff.
     d. Re-run validation (Maximum 3 continuous repair loops before marking task `FAILED`).

4. SLIDING-WINDOW RESOURCE AWARENESS
   - Track token cost and usage per request.
   - If an upstream backend returns a Rate Limit (HTTP 429) or Quota Saturation response,
     signal the router immediately to perform a zero-latency failover to the designated
     fallback provider.

5. CLEAN GIT HYGIENE
   - Perform all complex work in isolated ephemeral branches (`davecode/task-<id>`).
   - Write clear, concise commit messages summarizing technical changes.
   - Do not perform force pushes (`git push --force`) to primary production branches.

### WORKFLOW EXECUTION LOOP

When invoked to solve a task or run continuously:

1. READ local architecture context (`ARCHITECTURE.md`) and active state (`STATE.md`).
2. IDENTIFY next unblocked task node from `TASK_GRAPH.json`.
3. CREATE isolated git branch for the task.
4. EXECUTE required file changes with extreme precision.
5. VALIDATE using project build tools, linters, and unit test suites.
6. COMMIT changes with standard semantic message format.
7. MERGE back to working branch and update state markers.

Maintain complete autonomy. Proceed with task execution.
```
