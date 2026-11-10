# DaveCode guide

DaveCode runs the coding agents you already pay for (Claude Code, Codex and Antigravity) side by
side, on your machine, and coordinates them. It adds no model of its own: every reply and every
change comes from your own subscriptions or API keys.

This guide covers what you can do with it and what each part costs. For the HTTP API see
[API.md](API.md); for the internals, [ARCHITECTURE.md](ARCHITECTURE.md).

## Contents

- [Install and sign in](#install-and-sign-in)
- [The desktop workspace](#the-desktop-workspace)
- [Orchestrate: one objective, several agents](#orchestrate-one-objective-several-agents)
- [Isolated panes and the Changes panel](#isolated-panes-and-the-changes-panel)
- [The DaveCode chat](#the-davecode-chat)
- [Terminal commands](#terminal-commands)
- [What it costs](#what-it-costs)
- [Troubleshooting](#troubleshooting)

## Install and sign in

1. Download the desktop app from [davecode.app](https://davecode.app) or the
   [latest release](https://github.com/DMRLZZ/DaveCode/releases/latest), or install the terminal
   version with `npm install -g @dmrlzz/davecode`.
2. Sign in to your DaveCode account (Google, GitHub or email). The account only identifies you;
   your agent logins, keys and code stay on your machine.
3. Install the agent CLIs you want to use and sign in to each with its own login, once, in any
   terminal: `claude` for Claude Code, `codex` for Codex, `agy` for Antigravity.
   `davecode doctor` shows what is installed and what is missing.

The installers are not signed by a vendor yet. On Windows choose **More info → Run anyway**. On
macOS open the app once, then choose **Open Anyway** in **System Settings → Privacy & Security**.
The macOS build is for Apple silicon only.

## The desktop workspace

Open a project folder. The workspace shows real terminals, the same as any other terminal on
your machine.

- **Top bar:** add a **Shell**, **Claude Code**, **Codex**, **Antigravity** or **DaveCode** pane.
  Each agent pane starts that agent's own CLI, with its own login and its normal interface.
- **Bottom bar:** type one message. Choose what it does:
  - **Orchestrate** splits an objective across your agents (next section).
  - **Send to panes** types the same message into every agent pane you have open.
- **Connections, Dashboard, Settings** (top right) manage accounts, quotas and the look.

## Orchestrate: one objective, several agents

Type an objective in the bottom bar, for example _"Add a /health endpoint with tests and
document it in the README"_, and press Enter.

1. **The lead plans.** Pick the lead in the **lead** selector: Claude Code, Codex or
   Antigravity. It reads the project without changing anything and splits the objective into up
   to five tasks, choosing which agent does each one and which tasks depend on others.
2. **The agents work in parallel.** The agent chips choose who may take tasks. Each task runs
   headlessly in its own copy of the repository (a git worktree) on its own branch, so agents
   never edit the same files at the same time. Up to three tasks run at once, one per agent.
3. **The results are merged** into a `davecode/run-<id>` branch. A task that conflicts with the
   others is marked **conflict** and left out, never forced.
4. **You decide.** The panel on the right shows the plan, every task's live activity, the files
   it changed and a summary. **Apply to `<branch>`** merges the result into the branch you
   started from. Until then your files do not change, and DaveCode never pushes.

The project must be a git repository with at least one commit. From the terminal:
`davecode orchestrate "<objective>" --planner codex --agents claude,codex`.

Notes:

- Antigravity has no safe read-only mode, so when it leads it plans without seeing the files.
- In its tasks, Claude Code can edit files but cannot run commands such as your tests; Codex can.
- Worktrees do not have your installed dependencies (`node_modules` and similar).

## Isolated panes and the Changes panel

- **Isolated** (top bar, after the pane buttons): when it is on, every new pane gets its own worktree and branch
  (`davecode/pane-<id>`). Run several agents on the same project without them touching each
  other's files. The pane header shows its branch and how many lines it changed.
- **Changes panel:** a review of the project and of every isolated pane, with a line-numbered
  diff. Commit, commit and push, or commit, push and open a pull request, and merge a pane's
  branch back into your checkout. DaveCode can write the commit message and pull request text
  for you.

## The DaveCode chat

The **DaveCode** pane, and `davecode` in any terminal, is a chat. It is good for questions,
including questions about DaveCode itself. It cannot see or change your files: for work on a
project, open an agent pane or use Orchestrate.

The chat sends your message to the route you picked with `/model` (by default `davecode/auto`:
Claude Code first, then Codex, then Antigravity, moving to the next when one hits its limit).
Type `/` for commands: `/connect`, `/model`, `/status`, `/route`, `/accounts`, `/login`,
`/account`, `/clear`, `/help`, `/exit`.

## Terminal commands

| Command                                | What it does                                                                                                    |
| :------------------------------------- | :-------------------------------------------------------------------------------------------------------------- |
| `davecode`                             | The chat                                                                                                        |
| `davecode orchestrate "<objective>"`   | Orchestrate from the terminal (`--planner`, `--agents`, `--max-tasks`, `--apply`, `--list`, `--apply-run <id>`) |
| `davecode app`                         | The workspace in a Chrome or Edge app window                                                                    |
| `davecode login`, `logout`, `account`  | Your DaveCode account                                                                                           |
| `davecode accounts …`                  | Agent and API accounts, their plans and logins                                                                  |
| `davecode doctor`                      | Check the setup                                                                                                 |
| `davecode init`                        | Set up a project's `.davecode/` folder                                                                          |
| `davecode goal "<objective>"`, `goals` | Goal mode: a planned objective with reviewed results                                                            |
| `davecode run`, `tasks …`              | The autonomous runner on the project's task graph                                                               |
| `davecode start`, `status`             | Run the local gateway (OpenAI-compatible `/v1`) and check it                                                    |

## What it costs

DaveCode itself is free. Every reply is paid by the subscription or key that served it, and the
token counts it shows are that provider's own.

- **The chat** counts all the context the model reads for each message, not only what you typed.
  Each message resends the conversation so far. Since 0.7.1 the chat runs Claude Code without its
  tools and MCP servers, which the chat never used: a one-word reply reads about 3k tokens of
  context instead of about 34k (measured with Claude Code on 2026-11-09). Most of it is cached,
  which costs less of your quota than new input.
- **Agent panes** cost exactly what those CLIs cost when you use them yourself.
- **Orchestrate** runs one planning call plus one headless run per task, each with that agent's
  full tools. A two-task objective took about a minute in testing.

## Troubleshooting

- **macOS says the app is damaged.** Builds before 0.6.1 were not signed at all; download the
  current one. If an old copy is already installed, run
  `xattr -cr /Applications/DaveCode.app && codesign --force --deep --sign - /Applications/DaveCode.app`
  in Terminal.
- **"Could not open project".** The dialog shows the reason and the log file
  (`logs/startup.log` in the app's data folder). Right after installing, wait for the installer
  to finish before opening the app.
- **Orchestrate is missing from the bar.** No agent CLI is installed, or the folder is not
  opened as a project. Run `davecode doctor`.
- **"Not a git repository".** Orchestrate and isolated panes need git: run `git init` and commit
  once.
- **An agent says it is not signed in.** Open that agent in a pane (or any terminal) and sign in
  with its own login.
