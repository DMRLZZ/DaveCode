# DaveCode workspace: Warp research and implementation direction

Research date: 2026-10-22. This is a source and public-behavior analysis, not a
claim that DaveCode already reproduces Warp. No Warp code was copied.

## Product goal

One local application where a person describes an outcome, connects their own AI
tools, follows the work, and reviews the result. Opening a terminal, learning model
identifiers, or editing a configuration file should eventually be optional.
DaveCode itself has no subscription or credit system. Provider access can still
cost money and remains subject to provider limits. Local inference is the path
for users who want no model-provider subscription.

## What Warp actually does

Warp combines a terminal, code review/editing, agents, and reusable context.
Its input accepts prompts and commands. Its useful design principle is that a
command and its output form an addressable block, rather than an undifferentiated
screen of terminal text. Agent conversations can appear alongside command blocks.
See the [Warp 2.0 product description](https://www.warp.dev/blog/reimagining-coding-agentic-development-environment)
and [block model engineering article](https://www.warp.dev/blog/block-model-behind-warps-agentic-development-environment).

The article links to a pinned implementation of
[`BlockList` in `app/src/terminal/model/blocks.rs`](https://github.com/warpdotdev/warp/blob/8c055374680788cb0920f18082527a2d6c6842b5/app/src/terminal/model/blocks.rs).
The key architectural distinction is between the shell byte stream and the richer
model that gives commands and other content identities. A DaveCode implementation
should likewise keep raw terminal data separate from durable task/conversation
events; terminal text alone cannot represent approvals, diffs, or reliable state.

Warp also exposes completion, input-needed, and error notifications from third-party
agents. See [agent notifications](https://docs.warp.dev/agents/capabilities/agent-notifications/).
This suggests a capability-based integration: a CLI can be launchable before it
supports structured progress, and structured progress does not automatically imply
support for pause, resume, approvals, or session migration.

Two assumptions must be corrected:

- Warp's client is already open source. Its repository identifies the UI crates as
  MIT and the remainder as AGPL v3. DaveCode remains an independent MIT implementation;
  this change introduces no Warp dependency or copied source. See the
  [repository licensing section](https://github.com/warpdotdev/warp#licensing).
- Warp now offers BYOK and custom inference endpoints on Free. Being open source or
  supporting your own keys is insufficient differentiation. See its
  [pricing FAQ](https://docs.warp.dev/support-and-community/plans-and-billing/pricing-faqs).

The intended improvement is a simpler outcome-oriented flow, transparent provider
access, and local ownership. These are product targets, not measured superiority.

## Current DaveCode coverage

| User need              | Existing foundation                             | Remaining work                                                      |
| ---------------------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| Describe an outcome    | Goal planner, role agents, reviewer, task graph | Conversational follow-ups and attachments                           |
| Use several AI tools   | API and CLI providers, router, failover         | Verified native agent sessions rather than only completion adapters |
| Understand progress    | SSE, goal tasks/logs, runner logs               | Durable typed activity blocks with tool results                     |
| Connect accounts       | Account UI and official CLI login launcher      | In-app onboarding and dependency checks                             |
| Keep work local        | SQLite, project brain, local gateway            | Desktop installer, project picker and app-managed lifecycle         |
| Review changes         | Runner branches, checks and merge flow          | Visual diff review before applying changes                          |
| Stop opening terminals | Web dashboard controls goals                    | Embedded PTY/ConPTY terminal and interactive CLI session bridge     |
| Use Antigravity        | Official CLI exists; local `agy` 1.4.5 verified | Provider/session adapter and authenticated smoke test               |

The existing runner can merge completed code automatically. The new workspace's
plan-only default is not a new approval protocol, and a generated plan cannot yet
be resumed into execution with an approval button. Choosing execution starts a
new planning/execution run.

## First implemented slice

The default dashboard route is now **Workspace**. The operational overview remains
at `#/overview`; account, route, goal and runner screens remain available.

Workspace submits to the existing `POST /api/goals` through the shared UI client.
It defaults to plan-only, offers a token limit, lists configured AI accounts,
shows recent goals, and reuses the live goal detail/cancellation view. It labels
demo mode explicitly. Suggestions only fill the composer. Account configuration
is not presented as proof of a successful login. Model routing stays under the
existing project configuration; there is no cosmetic model selector pretending
to control a backend that does not accept per-goal model overrides.

## Antigravity discovery

The previous statement that Antigravity has no public CLI is outdated. Google now
documents [`agy` installation and authentication](https://antigravity.google/docs/cli/install/)
and a [CLI reference](https://antigravity.google/docs/cli/reference/).
On this Windows machine, `agy.exe` exists in `%LOCALAPPDATA%\agy\bin`, that folder
is in the user PATH, and `--version` and `--help` both work. The installed help
lists print mode and JSON/stream-JSON output. Authentication and the exact event
schema have not been tested; installing the binary does not establish either.

Implement an adapter only after checking this installed version's actual protocol,
credential isolation, cancellation, errors and account eligibility. Use official
authentication; never extract IDE tokens. First validate with recorded fixtures
and local-process mocks, then an explicitly chosen live smoke test. Do not install
or launch an agent with permission checks disabled as part of onboarding.

## Implementation sequence and acceptance criteria

1. **Workspace foundation (this change).** A goal entered in the UI reaches the
   existing goal engine; planning and execution are visibly different; simulation
   is labeled; errors remain visible; existing administration screens are reachable.
2. **Official agent sessions.** Introduce a core session lifecycle and capability
   model, documented with events/API contracts. Verify Claude, Codex, Gemini and
   Antigravity independently. Include executable discovery, login state, structured
   output, cancellation and reconnection. Do not translate interactive approval
   requests into silent acceptance. Keep adapters distinct from generic chat models.
3. **Integrated terminal.** Add project-scoped PTY sessions with Windows ConPTY
   support and a terminal renderer. Scope input/output to an authorized session,
   bound buffers, support resize and clean process shutdown. Commands and ordinary
   prompts must have explicit modes; sending natural language must never accidentally
   execute a shell command. Preserve a raw terminal view for unsupported TUIs.
4. **Review and recovery.** Persist ordered activity blocks and pending decisions,
   show file diffs, support review/apply/reject and restart recovery. Use isolated
   worktrees before enabling simultaneous edits by different agents. Test reconnect,
   cancellation, crashes and conflicts on all supported operating systems.
5. **Desktop and nontechnical onboarding.** Package the same UI and local service
   with a project picker, tool checks, official login, readable usage/cost explanations,
   and one-click launch. Validate with people unfamiliar with a terminal. Keep
   advanced settings available without making them prerequisites for first use.

Release readiness means a fresh installation can open a project, connect a tool,
complete a task, inspect the changes and recover a session without an external
terminal. This first slice does not meet that full release criterion yet.
