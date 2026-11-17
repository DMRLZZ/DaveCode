# DaveCode guide

DaveCode runs the coding agents you already pay for (Claude Code, Codex and Antigravity) side by
side, on your machine, and coordinates them. It adds no model of its own: every reply and every
change comes from your own subscriptions or API keys.

This guide covers what you can do with it and what each part costs. For the HTTP API see
[API.md](API.md); for the internals, [ARCHITECTURE.md](ARCHITECTURE.md).

## Contents

- [Install and sign in](#install-and-sign-in)
- [First-run setup](#first-run-setup)
- [The desktop workspace](#the-desktop-workspace)
- [Chats](#chats)
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

Windows and macOS warn about the installers because they are not signed with a vendor
certificate yet; nothing is wrong with the download. On Windows choose **More info → Run
anyway**. On macOS open the app once, then choose **Open Anyway** in **System Settings → Privacy
& Security**. [SIGNING.md](SIGNING.md) explains the warning and what removes it. The macOS build
is for Apple silicon only.

## First-run setup

The first time the desktop app opens a project it asks five things. Every choice applies at
once, and all of them are in **Settings → Workspace** later. **Set up later** keeps the defaults.

1. **How you work with agents.** **Terminal** opens each agent in its own CLI, exactly as it
   ships; it works with every agent. **Chat** opens Claude Code, Codex and Antigravity in a
   conversation with their edits shown as diffs (other agents still open in a terminal).
2. **Your default agent.** DaveCode finds the agent CLIs installed on your computer: Claude
   Code, Codex, Antigravity, OpenCode, Gemini CLI, GitHub Copilot, Qwen Code, Cursor CLI, Amp,
   Aider, Crush. The default one opens with **New** and `Ctrl+Shift+T`, and leads orchestrator
   runs when it can. **YOLO mode** starts agents with their own flag to run commands and edit
   files without asking (for example `claude --dangerously-skip-permissions`,
   `codex --dangerously-bypass-approvals-and-sandbox`); agents without such a flag ask as usual.
   Use it only on projects you trust.
3. **Look.** Dark, light or the system's mode, and a terminal theme for each mode.
4. **The Windows terminal** (Windows only). The shell new sessions open in: Windows PowerShell,
   PowerShell 7, Command Prompt, Git Bash or WSL (agents must then be installed inside WSL). And
   what a right click does: copy the selection or paste, or open a menu (`Ctrl` + right click
   always opens it).
5. **Notifications.** A system notification and a sound when an agent finishes or asks for you
   while you look elsewhere, when a chat answers and when an orchestrator run ends. Clicking it
   brings up that session. A session that finished also gets a dot in the sidebar.

The app remembers all of this, and that you chose **Continue on this device** at sign-in.

## The desktop workspace

Open a project folder. The workspace has two views, switched at the top: **Terminals** and
**Orchestrator**. Whatever runs in one keeps running while you look at the other.

**The sidebar** (left; hide it with `Ctrl+Shift+B`) lists:

- **Sessions.** One per pane. Press **+** to open a **Shell**, **Claude Code**, **Codex**,
  **Antigravity** or **DaveCode** session; each agent session starts that agent's own CLI, with
  its own login and its normal interface. Click a session to go to it. Double-click its name
  (or press F2 on it) to rename it. Hover for **minimize** and **close**.
- **Orchestrator.** Every run of this project, newest first. Click one to open its thread.
- **Changes**, **Connections**, **Dashboard** and **Settings**.

**Terminals** are real terminals, arranged like a tiling terminal:

| Do this                                | With                                                                                                                                |
| :------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| Split a pane to the right or downwards | The two split buttons in its bar, `Ctrl+Shift+D` / `Ctrl+Shift+E`. The new pane is a shell in the same folder.                      |
| Resize                                 | Drag any border. Double-click a border, or use the button at the top right, to even the panes out.                                  |
| Maximize one pane, and back            | The maximize button, a double-click on its bar, or `Ctrl+Shift+Enter`. While one is maximized, picking another session swaps it in. |
| Minimize                               | The **–** button or `Ctrl+Shift+M`. The session keeps running and stays in the sidebar; click it there to bring it back.            |
| Rename                                 | Double-click the name in the pane's bar or in the sidebar.                                                                          |
| Close                                  | The **×** button or `Ctrl+Shift+W`. This ends the session.                                                                          |

**Next time you open the project** the workspace comes back as you left it: the same
sessions with their names, the same panes and sizes, minimized ones still minimized, and the
sidebar and the access choice below. What ran inside them starts again fresh: a shell opens a
new prompt and an agent a new conversation. Each project keeps its own workspace.

**The message box** at the bottom takes one message, several lines if you like (`Shift+Enter`
for a new line, `Enter` to send). Choose what it does:

- **Orchestrate** splits an objective across your agents (next section).
- **Send to panes** types the same message into every agent pane you have open, or only into
  the pane you are in: pick the receiver next to **to**.

## Chats

**Chats** (a tab at the top, and a section of the sidebar) talk to Claude Code, Codex or
Antigravity in a conversation instead of a terminal. Each message runs the agent in the project
folder with its own login and continues the same conversation, so it remembers what came before.

Every answer shows how long the agent worked and its steps (what it read, ran and edited; open
them to read all of it), its reply, and **Edited …** with the files it changed in that turn and
their diff. Only that turn's changes are shown, not what you had pending before. **Stop** ends
the turn; the trash button deletes the chat but not the files the agent changed.

The **edits only / runs commands** button under the message box works as for the orchestrator:
with **edits only**, Claude Code changes files but runs no command; with **runs commands** it
runs them with your permissions. YOLO mode makes **runs commands** the default.

## Orchestrate: one objective, several agents

Type an objective in the message box, for example _"Add a /health endpoint with tests and
document it in the README"_, and press Enter. The **Orchestrator** view opens on the run's
thread.

1. **The lead plans.** Pick the lead in the **lead** selector: Claude Code, Codex or
   Antigravity. It reads the project without changing anything and splits the objective into up
   to five tasks, choosing which agent does each one and which tasks depend on others.
2. **The agents work in parallel.** The agent chips choose who may take tasks. Each task runs
   headlessly in its own copy of the repository (a git worktree) on its own branch, so agents
   never edit the same files at the same time. Up to three tasks run at once, one per agent.
3. **The results are merged** into a `davecode/run-<id>` branch. A task that conflicts with the
   others is marked **conflict** and left out, never forced.
4. **You decide.** **Apply to `<branch>`** merges the result into the branch you started from.
   Until then your files do not change, and DaveCode never pushes.

**Nothing is hidden.** The thread shows your objective, the plan as a list of tasks, and one
card per agent, all on screen at the same time. Each card shows live what that agent reads,
edits and runs, then its own summary, the files it changed and its branch. Expand a card to
read it in full. Runs are kept: open an older one from the sidebar and its cards still show
what each agent did.

**What the agents may run.** The button next to the agent chips sets it for the next run:

- **edits only** (the default): agents change files in their worktree. Codex and Antigravity
  still run commands inside their own sandbox. Claude Code has no sandbox, so it runs no
  command at all and tells you which command to run to check its work.
- **runs commands**: Claude Code may also run shell commands (your tests, builds, installs),
  and Codex gets network access in its sandbox. These commands run **with your own
  permissions**, the same as if you had typed them. Use it on projects you trust.

If an agent is cut off mid-task (a dropped connection, a CLI that dies), DaveCode starts it once
more in the same worktree, where its unfinished work still is. It does not retry an agent that
is signed out, out of quota or rate limited.

The project must be a git repository with at least one commit. From the terminal:
`davecode orchestrate "<objective>" --planner codex --agents claude,codex [--full-access]`.

Notes:

- Antigravity has no safe read-only mode, so when it leads it plans without seeing the files.
- Worktrees do not have your installed dependencies (`node_modules` and similar), so a test
  that needs them fails until the agent installs them (it can, with **runs commands**).

## Isolated panes and the Changes panel

- **Isolated worktree** (a checkbox under the session kinds, in the sidebar's **+** menu): when
  it is on, every new session gets its own worktree and branch (`davecode/pane-<id>`). Run
  several agents on the same project without them touching each other's files. The pane's bar
  and the sidebar show its branch; the bar also shows how many lines it changed. Splitting an
  isolated pane opens a shell in the same worktree, to look at what the agent is doing.
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
