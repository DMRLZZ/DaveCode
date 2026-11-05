# Configuration

DaveCode resolves its configuration from these layers, later ones winning:

1. built-in defaults
2. user config: `~/.davecode/config.json` (`$DAVECODE_HOME/config.json`)
3. project config: `<repo>/.davecode/config.json`
4. `DAVECODE_*` environment variables
5. flags passed by the CLI

Objects merge key by key; arrays replace. The full schema is in
`packages/core/src/config/schema.ts`; the runner and goal keys are described in
[API.md](API.md).

## Project config is untrusted

A repository you clone can contain its own `.davecode/config.json`. Because you did not write
it, only an explicit allow-list of keys is read from it. Everything else is ignored, and the
loader prints one warning that names the ignored keys and the file:

```
Ignored server, runner.judge.baseUrl in /path/to/repo/.davecode/config.json: project config
cannot set these keys. Set them in your user config (~/.davecode/config.json) or with
DAVECODE_* environment variables.
```

The rest of the file still applies and the load does not fail.

A project config may set:

| Key                                                                                                                                                                            | Why it is safe                                         |
| :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------- |
| `logLevel`                                                                                                                                                                     | Verbosity only                                         |
| `routing.*`                                                                                                                                                                    | Which of your own accounts and models serve a route    |
| `goal.*`                                                                                                                                                                       | Limits and roles for goal mode                         |
| `runner.maxRepairCycles`, `branchPrefix`, `baseBranch`, `route`, `executor`, `pullRequests`, `commitBrain`, `commandTimeoutMs`, `idlePollMs`, `maxIterations`, `maxTaskTokens` | Behaviour of a run in this repository                  |
| `runner.validate.*`                                                                                                                                                            | The repository's own lint, typecheck and test commands |
| `runner.claudeCli.accountId`, `model`, `timeoutMs`                                                                                                                             | Selection and limits for the `claude-cli` executor     |
| `runner.judge.kind`, `model`, `threshold`                                                                                                                                      | Whether and how a task is judged                       |

These keys are ignored in a project config and must come from the user config or the
environment:

| Key                                                                  | Why                                                                        |
| :------------------------------------------------------------------- | :------------------------------------------------------------------------- |
| `server.host`, `server.port`, `server.authToken`, `server.dashboard` | They decide who can reach the gateway and its accounts                     |
| `experimental.*`                                                     | Terms-of-service opt-ins must be your own decision                         |
| `runner.judge.baseUrl`                                               | The judge endpoint receives your API key                                   |
| `runner.allowedCommands`                                             | Widens which programs the model may start                                  |
| `runner.claudeCli.allowedTools`                                      | Widens what Claude Code may do without asking                              |
| any key not listed above                                             | New keys are untrusted until they are deliberately added to the allow-list |

`runner.validate.*` is allowed on purpose: running the repository's own checks is what the
autonomous runner is for (see SECURITY.md). Review a repository before running the runner on it,
as you would before running its tests.

The allow-list lives in `PROJECT_SETTABLE_KEYS` in `packages/core/src/config/loader.ts`. Adding a
key to the schema does not make it project-settable.

## Account settings

Provider accounts are stored in the local database, not in `config.json`. The HTTP API (and
therefore the dashboard) can only write an allow-list of account `config` keys, and cannot change
an account's executable path or arguments. See "Accounts" in [API.md](API.md).
