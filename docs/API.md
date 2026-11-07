# DaveCode HTTP API

The gateway listens on `http://127.0.0.1:4040` by default and exposes two surfaces:

| Prefix | Audience                                             | Purpose                                                          |
| :----- | :--------------------------------------------------- | :--------------------------------------------------------------- |
| `/v1`  | Any OpenAI-compatible client (SDKs, editors, agents) | Chat completions with quota-aware routing and hot failover       |
| `/api` | The DaveCode dashboard, TUI and scripts              | Accounts, usage, routes, task graph, runner control, live events |

All shapes referenced below (`Account`, `AccountUsage`, `UsageRecord`, `Route`, `TaskGraph`,
`RunnerStatus`, `DaveEvent`, …) are defined in
[`packages/core/src/types.ts`](../packages/core/src/types.ts) and
[`packages/core/src/events.ts`](../packages/core/src/events.ts). They are the source of truth.

## Authentication

If `server.authToken` is configured, every `/v1` and `/api` request must send
`Authorization: Bearer <token>`. Because `EventSource` cannot set headers, `GET /api/events`
also accepts `?token=<token>`. With no token configured the gateway only binds to loopback
by default.

### Browser safety checks

These apply with or without a token:

- On a gateway bound to loopback, the `Host` header must be `127.0.0.1`, `localhost` or `[::1]`
  with the port the gateway listens on (or the host of a configured origin); anything else is
  `403 invalid_host`. A gateway bound to a network address accepts the name it was configured with.
- A state-changing `/api` request (`POST`, `PUT`, `PATCH`, `DELETE`) that carries an `Origin`
  header must come from the gateway's own origin or an origin set in `corsOrigins`
  (and the Vite dev server in dev mode only); otherwise `403 invalid_origin`. Requests with no
  `Origin` (CLI, scripts, SDKs) are unaffected.
- Every `POST /api/*` request must send `Content-Type: application/json`, even with an empty
  body (for example `POST /api/runner/start`); otherwise `415 json_required`. The
  `/api/auth/*` sign-in routes are exempt.

## Errors

- `/v1/*` uses the OpenAI error envelope:
  `{ "error": { "message": string, "type": string, "code": string | null } }`
- `/api/*` uses `{ "error": { "message": string, "code": string } }`

| Status | Meaning                                                                                                                                                                                                                                                                                                               |
| :----- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | Invalid body (zod validation message included, code `invalid_body`), or `experimental_disabled`                                                                                                                                                                                                                       |
| 401    | Missing/invalid bearer token (`invalid_api_key` on `/v1`, `unauthorized` on `/api`)                                                                                                                                                                                                                                   |
| 404    | Unknown resource (`not_found`) or no account can serve the model (`model_not_found`)                                                                                                                                                                                                                                  |
| 404    | also `task_not_found`: `POST /api/runner/start` named a task id that does not exist                                                                                                                                                                                                                                   |
| 409    | The autonomous runner refused to start; `code` is the `RunnerError` code: `not_a_repo`, `no_brain`, `no_base_branch`, `dirty_worktree`, `invalid_graph`, `busy`, or for a targeted start `task_not_runnable` (the task is not `PENDING`) and `task_blocked` (it depends on unfinished tasks, which the message names) |
| 429    | Every candidate account is saturated or cooling down (`no_capacity`), or every attempt was rate limited upstream (`rate_limited`)                                                                                                                                                                                     |
| 501    | The autonomous runner is not available in this process (`runner_unavailable`)                                                                                                                                                                                                                                         |
| 502    | All failover targets failed upstream (`upstream_failed`), or upstream credentials were rejected (`upstream_auth_error`)                                                                                                                                                                                               |
| 503    | Matching accounts exist but none is usable: disabled, in error or without an adapter (`no_available_account`)                                                                                                                                                                                                         |

Upstream errors that are not failover-eligible are returned as-is with their kind as `code`:
`bad_request` → 400, `context_length` → 400 `context_length_exceeded`, `auth` → 502
`upstream_auth_error` (the account is marked `error`), anything else → 502.

---

## OpenAI-compatible surface (`/v1`)

### `GET /v1/models`

```json
{ "object": "list", "data": [ModelInfo, ...] }
```

Includes every model of every enabled account plus one entry per configured route, exposed as
`davecode/<route-name>` (e.g. `davecode/auto`), with `owned_by: "davecode"`. The default route
(`routing.defaultRoute`) is always listed. An account's models come from `config.models` when
set, otherwise from its provider adapter.

### `POST /v1/chat/completions`

Body: `ChatRequest`. The `model` field accepts:

1. `davecode/<route>`: use a configured route (ordered failover targets). Unknown names fall
   back to the default route. If the default route is not configured, every account that sets
   `config.defaultModel` (or `config.models`) is a candidate with that model.
2. `<provider>/<model>`, e.g. `anthropic/claude-sonnet-5-5`: any account of that provider (and,
   when the account sets `config.models`, only if the model is listed).
3. A bare model id: accounts that list it in `config.models`; accounts without a list match when
   the id belongs to their provider family (`claude*`, `gpt-*`/`o<n>*`, `gemini*`), and
   `openai-compatible` accounts match unknown families.

Non-streaming responses return a `ChatCompletion`. With `"stream": true` the response is
`text/event-stream` with one `data: <ChatCompletionChunk JSON>` line per chunk, terminated by
`data: [DONE]`.

Response headers:

| Header                  | Description                                                    |
| :---------------------- | :------------------------------------------------------------- |
| `x-davecode-request-id` | Correlates with `request.*` events and `UsageRecord.requestId` |
| `x-davecode-account`    | Account id that finally served the request                     |
| `x-davecode-provider`   | Provider kind that served the request                          |
| `x-davecode-failovers`  | Number of failover hops taken                                  |

Failover only happens **before the first byte** is sent to the client; once a stream has started,
upstream errors are forwarded as a final error chunk.

---

## Dashboard API (`/api`)

### Health

`GET /api/health`

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptimeSec": 123,
  "experimental": { "geminiWeb": false, "multiAccountRotation": false }
}
```

### Accounts

| Method   | Path                           | Body            | Response                              |
| :------- | :----------------------------- | :-------------- | :------------------------------------ |
| `GET`    | `/api/accounts`                | —               | `{ "accounts": Account[] }`           |
| `POST`   | `/api/accounts`                | `AccountCreate` | `201 { "account": Account }`          |
| `PATCH`  | `/api/accounts/:id`            | `AccountPatch`  | `{ "account": Account }`              |
| `DELETE` | `/api/accounts/:id`            | —               | `204`                                 |
| `GET`    | `/api/accounts/:id/connection` | —               | `{ "connection": AccountConnection }` |
| `POST`   | `/api/accounts/:id/connect`    | `{}` (JSON)     | `{ "connect": ConnectResult }`        |

`POST /api/accounts/:id/connect` ("Connect subscription") starts the vendor's **official** login
for a `cli-login` account (`claude auth login`, `codex login`, Gemini CLI's "Login with Google")
via `davecode accounts login <id>`, isolated in the account sandbox. DaveCode never sees or
stores the password or the resulting tokens; they stay in the vendor CLI's own store inside the
sandbox. When the gateway was started with a `loginLauncher` (`davecode start` injects one when
bound to a loopback address), it opens a terminal window on the gateway machine and answers
`launched: true`; otherwise `launched: false` and `command` tells the user what to run. Poll
`GET …/connection` to see when the login lands. Errors: `415 json_required` without
`Content-Type: application/json` (blocks cross-site form posts), `400 not_cli_login` for API-key
and `gemini-web` accounts, `404 not_found`.

```ts
interface AccountCreate {
  provider: ProviderKind;
  label: string;
  priority?: number; // default 100
  weight?: number; // default 1
  limits?: QuotaLimits;
  config?: Record<string, unknown>;
  subscription?: SubscriptionInfo; // plan, paid/renewal dates, optional price
  secret?: string; // API key / token — encrypted at rest, never returned
}
type AccountPatch = Partial<Omit<AccountCreate, 'provider' | 'subscription'>> & {
  enabled?: boolean;
  subscription?: SubscriptionInfo | null; // replaces; null clears
};
```

`subscription` is validated strictly: dates are `YYYY-MM-DD` or ISO timestamps, `price.currency`
is a 3-letter code (upper-cased), `price.period` is `month` or `year`, unknown keys are rejected.

Secrets are write-only: no endpoint ever returns them. `Account.hasSecret` tells you whether one is stored. Creating a `gemini-web` account while
`experimental.geminiWeb` is off returns `400` with code `experimental_disabled`. Unknown body
fields and credential-like `config` keys (`apiKey`, `token`, `password`, `cookie`…) are rejected
with `400 invalid_body`; send credentials in `secret`. `AccountCreate` also accepts
`enabled?: boolean`.

`config` is an allow-list per provider, not free-form. Through the API you can set `baseUrl`
(`anthropic`, `openai`, `gemini`, `openai-compatible`; an `http(s)` URL without embedded
credentials), `models` (list of ids), `defaultModel`, and `includeUsage` (`openai`,
`openai-compatible`); `gemini-web` takes `models` only. Any other key, notably `binaryPath` and
`binaryArgs`, is rejected with `400 invalid_body`: executable settings come only from the local
`davecode accounts add --binary-path` (which writes to the local database) or from editing the
database as the machine's owner. A `PATCH` that sends `config` replaces the API-writable keys and
keeps the others; echoing back an unchanged stored value is accepted.

A stored secret is bound to the endpoint it was saved with. A `PATCH` that changes or removes
`config.baseUrl` on an account where `hasSecret` is `true` is rejected with
`400 secret_required` unless the same request carries a new `secret`.

`PATCH` with `enabled: false` sets `status: "disabled"`. `enabled: true` or a new `secret`
resets an enabled account to `active` and clears `cooldownUntil` and `lastError`.

`ProviderKind` is one of `anthropic`, `openai`, `gemini`, `openai-compatible` (API keys),
`claude-cli`, `codex-cli`, `gemini-cli` (subscription logins held by the vendor's own CLI inside
the account's sandbox: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`), `antigravity-cli`
(Google Antigravity's `agy`; its sign-in lives in the OS keyring and is shared by the machine) and
the experimental `gemini-web`. `gemini-cli` runs the official Gemini CLI with "Login with Google";
a fresh sandbox is seeded with `.gemini/settings.json` selecting `oauth-personal`.

#### Subscription & budget contracts

`Account.subscription?: SubscriptionInfo` records what the user pays for the account. It is
entered by hand: DaveCode never scrapes billing pages. It is omitted when nothing was entered.

```ts
interface SubscriptionInfo {
  plan?: string; // "Claude Pro", "ChatGPT Plus", "API pay-as-you-go"…
  paidAt?: string; // YYYY-MM-DD or ISO timestamp
  renewsAt?: string; // YYYY-MM-DD or ISO timestamp
  price?: { amount: number; currency: string; period: 'month' | 'year' };
  notes?: string;
}

// Rate-limit state the provider itself reported: response headers (Anthropic
// `anthropic-ratelimit-*`, OpenAI `x-ratelimit-*`) or a quota/limit error, including the
// subscription CLIs' "usage limit reached… resets at" messages.
interface ReportedLimits {
  tokensRemaining?: number;
  tokensLimit?: number;
  requestsRemaining?: number;
  requestsLimit?: number;
  resetAt?: string; // ISO
  exhausted?: boolean; // refused until resetAt
  source: 'headers' | 'error';
  observedAt: string; // ISO
}

interface AccountBudget {
  accountId: string;
  label: string;
  provider: ProviderKind;
  enabled: boolean;
  subscription?: SubscriptionInfo;
  renewsInDays?: number; // negative when overdue
  remaining: number | null; // 0..1 of the tightest known limit; null = unmetered
  tightestWindow?: QuotaWindow; // when `remaining` comes from DaveCode's own limits
  usage: AccountUsage;
  reported?: ReportedLimits;
  available: boolean; // would the router send traffic there now?
  unavailableReason?: string; // disabled, error, cooldown, exhausted…
}

interface BudgetSnapshot {
  generatedAt: string;
  accounts: AccountBudget[];
  context: string; // compact text injected into agent prompts
}
```

`ProviderCallContext.reportLimits?(limits)` is how adapters hand reported limits to the router.
It receives the same fields without `source`/`observedAt`.

#### Connection contracts

Whether an account can authenticate, checked without reading or returning credentials.

```ts
type ConnectionMethod = 'api-key' | 'cli-login' | 'browser';
type ConnectionStatus = 'connected' | 'not_connected' | 'unknown';

interface AccountConnection {
  accountId: string;
  provider: ProviderKind;
  method: ConnectionMethod;
  status: ConnectionStatus;
  detail?: string; // explanation or caveat; never credentials or account emails
  loginCommand?: string; // `davecode accounts login <id>` (cli-login only)
  checkedAt: string; // ISO
}

interface ConnectResult {
  connection: AccountConnection;
  launched: boolean; // the gateway opened a terminal running the official login
  command: string; // what to run by hand otherwise
  message: string;
}
```

How each method is checked (core `ConnectionChecker`, exposed as `engine.connections`):

| Provider          | Check                                                                                                                                                                                                                                                                                     |
| :---------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API-key kinds     | `hasSecret` (keyring). `openai-compatible` without a key counts as connected.                                                                                                                                                                                                             |
| `claude-cli`      | `claude auth status --json` (`loggedIn`) with `CLAUDE_CONFIG_DIR` set. When it reports a login but the sandbox holds no `.credentials.json` (outside macOS, where the keychain is used), `detail` warns that it is probably the global Claude Code login and the account is not isolated. |
| `codex-cli`       | exit code of `codex login status` with `CODEX_HOME` set.                                                                                                                                                                                                                                  |
| `antigravity-cli` | exit code of `agy models`, which needs a signed-in Google account.                                                                                                                                                                                                                        |
| `gemini-cli`      | presence of `<sandbox>/.gemini/oauth_creds.json` (written by Gemini CLI; never read).                                                                                                                                                                                                     |
| `gemini-web`      | `unknown`: checking would mean opening the browser profile.                                                                                                                                                                                                                               |

Vendor output is parsed for the logged-in flag only and never returned.

### Usage

`GET /api/usage`

```json
{ "usage": AccountUsage[] }
```

`GET /api/budget`

```json
{ "budget": BudgetSnapshot }
```

One `AccountBudget` per account (see _Subscription & budget contracts_): subscription details,
days to renewal, the remaining share of the tightest known limit (DaveCode's own windows and the
limits the provider reported, whichever is lower), and whether the router would use the account
right now, with a human reason when it would not. `context` is the compact summary that the
autonomous runner and goal mode append to their prompts. Secrets are never included.

`GET /api/usage/timeseries?minutes=60&bucketSec=60`

Returns `{ "buckets": UsageBucket[] }`, oldest first. Buckets are aligned to `bucketSec`
boundaries and zero-filled; `tokens` is prompt + completion. Every upstream **attempt** is
counted (successful, failed and rate-limited alike; failed attempts usually carry 0 tokens), and
the last bucket is the current, still-filling one.

```json
{
  "buckets": [
    {
      "ts": 1760000000000,
      "tokens": 1234,
      "requests": 5,
      "byAccount": { "acc_1": { "tokens": 1000, "requests": 4 } }
    }
  ]
}
```

`GET /api/requests?limit=100`

```json
{ "requests": UsageRecord[] }
```

Most recent first; `limit` defaults to 100 and is capped at 1000 (`/api/logs` defaults to 200,
same cap). There is **one record per upstream attempt**: a request that failed over twice yields
three records sharing the same `requestId`, which is how clients rebuild failover chains.
`ts` is when the attempt finished, `latencyMs` its duration, and `model` is the concrete
upstream model that was called (not the `davecode/<route>` alias the client asked for). The
same holds for `model` in `request.*` events.

`status` is `success`, `error`, `rate_limited` or `cancelled`. `cancelled` means the client
aborted (closed the connection, pressed Esc in the TUI): the tokens used so far are recorded, but
the account is not cooled down, no failover happens and no `request.failed` event is emitted.

### Routes

`GET /api/routes`

```json
{ "defaultRoute": "auto", "routes": Route[] }
```

`PUT /api/routes`

```json
{ "routes": [Route, ...], "defaultRoute": "auto" }
```

Replaces the whole route list (`Route` is the config schema's route shape: lowercase kebab-case
`name`, optional `description`, one or more ordered `targets` of `{ provider, model,
accountId? }`) and optionally the default route. `defaultRoute` is optional; when present it must
be one of the submitted routes, and when omitted the stored value is left alone. Route names must
be unique and a pinned `accountId` must exist. An empty list removes every route.

The change is written to the **global** `~/.davecode/config.json` (`$DAVECODE_HOME/config.json`):
the file is read, only `routing.routes` / `routing.defaultRoute` are replaced, every other key is
preserved, and the result is written atomically under a lock file. The live engine config is
updated as well, so the router uses the new routes for the very next request (no restart). The
response is

```json
{ "defaultRoute": "auto", "routes": Route[], "shadowedByProject": false }
```

`shadowedByProject` is `true` when the project's `.davecode/config.json` also sets
`routing.routes` or `routing.defaultRoute`: that layer wins over the global file after a restart,
so edit it there too. Errors: `400 invalid_body` (schema, duplicate names, `defaultRoute` not in
the list), `400 unknown_account`, and `409 config_invalid` when the existing global config file
is malformed or invalid (it is never overwritten).

### Project brain & task graph

`GET /api/tasks`

```json
{ "project": { "root": "/path/to/repo", "name": "repo" } | null, "graph": TaskGraph }
```

#### Editing the task graph

| Method   | Path             | Body         | Response                   |
| :------- | :--------------- | :----------- | :------------------------- |
| `POST`   | `/api/tasks`     | `TaskCreate` | `201 { "task": TaskNode }` |
| `PATCH`  | `/api/tasks/:id` | `TaskPatch`  | `{ "task": TaskNode }`     |
| `DELETE` | `/api/tasks/:id` | none         | `204`                      |

```ts
interface TaskCreate {
  id: string; // lowercase kebab-case / snake_case, letters, digits and - _ .
  title: string; // 1..300 chars (trimmed)
  description?: string;
  dependsOn?: string[]; // ids of existing tasks
  priority?: number;
  acceptance?: string[];
}
interface TaskPatch {
  // at least one field; unknown fields are rejected
  title?: string;
  description?: string | null; // null removes the field
  dependsOn?: string[]; // replaces the list
  priority?: number | null;
  acceptance?: string[] | null;
  notes?: string | null;
  status?: TaskStatus; // must follow the allowed transitions
}
```

Created tasks are always `PENDING`. Every write goes through the project brain: it takes the
`.davecode/.lock` file, re-validates the whole graph, writes `TASK_GRAPH.json` atomically and
emits `task.updated` (`task.removed` with `{ taskId }` for a delete) on `/api/events`.

Status transitions (`canTransition`): `PENDING → IN_PROGRESS`; `IN_PROGRESS → SUCCESS | FAILED |
PENDING`; `FAILED | SUCCESS → PENDING`. Moving to `IN_PROGRESS` increments `attempts`.

| Status | `code`                                  | When                                                                                                                  |
| :----- | :-------------------------------------- | :-------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_body`                          | The body does not match the schema above                                                                              |
| 400    | `cycle`                                 | The change would create a dependency cycle. `error.cycle` is the path, first id repeated at the end (`["a","b","a"]`) |
| 400    | `unknown_dependency`, `self_dependency` | `dependsOn` names a missing task, or the task itself                                                                  |
| 404    | `not_found`                             | Unknown task id                                                                                                       |
| 409    | `duplicate_id`                          | `POST` with an id that already exists                                                                                 |
| 409    | `invalid_transition`                    | The status change is not allowed from the current status                                                              |
| 409    | `has_dependents`                        | `DELETE` of a task other tasks depend on. `error.dependents` lists them; remove or re-point them first                |
| 409    | `task_in_progress`                      | `DELETE` of an `IN_PROGRESS` task (reopen it first)                                                                   |
| 409    | `no_brain`                              | The gateway has no project brain, or the project was never initialised                                                |
| 501    | `brain_read_only`                       | The gateway's `BrainSource` has no write methods                                                                      |

In code, `BrainSource` gains the optional methods `createTask`, `updateTask` and `removeTask`
(core's `ProjectBrainSource` provides them when wrapping a `ProjectBrain`); a source without them
stays read-only.

`GET /api/brain`

```json
{ "state": "<STATE.md markdown>", "architecture": "<ARCHITECTURE.md markdown>" }
```

### Autonomous runner

| Method | Path                | Response                     |
| :----- | :------------------ | :--------------------------- |
| `GET`  | `/api/runner`       | `{ "status": RunnerStatus }` |
| `POST` | `/api/runner/start` | `{ "status": RunnerStatus }` |
| `POST` | `/api/runner/pause` | `{ "status": RunnerStatus }` |
| `POST` | `/api/runner/stop`  | `{ "status": RunnerStatus }` |

`POST /api/runner/start` takes an optional JSON body (an empty body or `{}` keeps the old
behaviour):

```json
{ "taskId": "build-api" }
```

With `taskId` the loop starts on that task instead of the runner's own pick, then carries on
with `nextTask` as usual. The task must exist (else `404 task_not_found`), be `PENDING` (else
`409 task_not_runnable`) and have every dependency `SUCCESS` (else `409 task_blocked`). Unknown
body fields are rejected with `400 invalid_body`.

When the gateway runs without a project brain, `/api/tasks` returns `project: null` with an
empty graph and `/api/brain` returns empty strings. Without a runner, `GET /api/runner` returns
`{ "status": { "state": "idle" } }` and the control endpoints return `501 runner_unavailable`.

With the core `AutonomousRunner` (wired by `pnpm dev` inside an initialised project):

- `start` resolves as soon as the loop is running (it does not wait for tasks) and resumes a
  paused runner. If a precondition fails (not a git repository, no brain, missing base branch,
  uncommitted changes outside `.davecode/`, invalid task graph) it returns `409` with the
  reason in `error.message`, and `status` becomes `{ "state": "error", "lastError": … }`.
- `pause` takes effect at the next step boundary: the status reads `paused` immediately while
  an in-flight model call or check finishes.
- `stop` aborts the in-flight model call or command, keeps partial work on the task branch,
  sets the task back to `PENDING` and returns once the runner is `stopped`.

Progress is streamed on `/api/events` as `runner.status` (every transition, with `taskId` and
`repairCycle`), `runner.log` (`{ level, message, taskId? }`), `task.updated` and `task.removed`.

### Runner library API (`@davecode/core`)

The CLI drives the same runner in-process:

```ts
const engine = createEngine({ projectRoot });
const brain = new ProjectBrain(projectRoot, { events: engine.events });
const runner = createRunner(engine, { brain }); // executor and judge from runner.* config
const result = await runner.runOnce(); // one task: RunOnceResult
await runner.runOnce({ taskId: 'build-api' }); // a specific task instead of the next one
await runner.start(); // or run 24/7 (start({ taskId }) begins with that task); pause(), stop(), status()
```

`RunOnceResult`: `{ outcome: 'success' | 'failed' | 'idle' | 'stopped' | 'error', task?,
repairCycles, summary?, validation?: ValidationReport, verdict?: JudgeVerdict,
delivery?: { mode: 'merge' | 'pr', url? }, branch?, error? }`. Preconditions reject with
`RunnerError` (`code`: `not_a_repo`, `no_brain`, `no_base_branch`, `dirty_worktree`,
`invalid_graph`, `busy`, and with `taskId` also `task_not_found`, `task_not_runnable`,
`task_blocked`).

Runner configuration (`runner.*`, all optional):

| Key                                                            | Default                                                                           | Meaning                                                                                           |
| :------------------------------------------------------------- | :-------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------ |
| `maxRepairCycles`                                              | `3`                                                                               | Repair passes after the first implementation before the task is `FAILED`                          |
| `branchPrefix` / `baseBranch`                                  | `davecode/task-` / `main`                                                         | Task branches and merge target                                                                    |
| `route`                                                        | `auto`                                                                            | Route (`davecode/<route>`) or model id for the `builtin` executor                                 |
| `executor`                                                     | `builtin`                                                                         | `builtin` tool loop or `claude-cli` delegation                                                    |
| `pullRequests`                                                 | `false`                                                                           | Push and `gh pr create` instead of merging locally (falls back to merge)                          |
| `commitBrain`                                                  | `true`                                                                            | Commit STATE.md / TASK_GRAPH.json on the base branch after each task                              |
| `commandTimeoutMs`                                             | `600000`                                                                          | Timeout per validation command and per `run_command`                                              |
| `idlePollMs`                                                   | `30000`                                                                           | Sleep between polls when no task is ready                                                         |
| `maxIterations`                                                | `40`                                                                              | Model round-trips per implementation or repair pass                                               |
| `maxTaskTokens`                                                | `1500000`                                                                         | Token budget per task across passes                                                               |
| `allowedCommands`                                              | `pnpm npm npx node git tsc biome vitest`                                          | Executables `run_command` may start (user config only, see CONFIG.md)                             |
| `claudeCli.accountId` / `model` / `allowedTools` / `timeoutMs` | first enabled account / CLI default / file tools + common `Bash(...)` / `1800000` | `claude-cli` executor settings                                                                    |
| `validate.lint` / `typecheck` / `test`                         | unset                                                                             | Quality-gate commands (split into argv, run without a shell)                                      |
| `judge.kind`                                                   | `none`                                                                            | `none`, `jev` (OpenRouter Decisions API, key from `OPENROUTER_API_KEY` or `JEV_API_KEY`) or `llm` |
| `judge.model` / `baseUrl` / `threshold`                        | `typesafe/jev-1.13` or `runner.route` / `https://openrouter.ai/api/alpha` / `0.7` | Judge model, Decisions API base URL, minimum confidence                                           |

### Goals

| Method | Path                               | Body             | Response                                                                  |
| :----- | :--------------------------------- | :--------------- | :------------------------------------------------------------------------ |
| `GET`  | `/api/goals`                       | —                | `{ "goals": Goal[] }`                                                     |
| `GET`  | `/api/goals/:id`                   | —                | `{ "goal": Goal }`                                                        |
| `POST` | `/api/goals`                       | `GoalStartInput` | `202 { "goal": Goal }`                                                    |
| `POST` | `/api/goals/:id/execute`           | —                | `202 { "goal": Goal }` (runs a `planned` dry-run goal)                    |
| `GET`  | `/api/goals/:id/artifacts/:taskId` | —                | `{ "artifact": { "taskId": string, "path": string, "content": string } }` |
| `POST` | `/api/goals/:id/cancel`            | —                | `{ "goal": Goal }` (once it has stopped)                                  |

```ts
interface GoalStartInput {
  objective: string; // 1–4000 chars
  maxRounds?: number; // 1–20, overrides goal.maxRounds
  maxTasks?: number; // 1–100
  maxTokens?: number; // ≥ 1000
  dryRun?: boolean; // plan only: no task is executed
}
```

`POST /api/goals` persists the goal and starts it in the background; follow it with
`goal.updated` / `goal.log` events or by polling `GET /api/goals/:id`. One goal runs at a time,
and a non-dry-run goal takes the same workspace lock as the autonomous runner, so a busy
repository answers `409 busy`. Other errors: `404 not_found`, `400 invalid` / `invalid_body`.
Without a project brain (gateway started outside an initialised repository) every route returns
`501 goals_unavailable`. Goals are stored under `<repo>/.davecode/goals/<goal-id>/` (`goal.json`
plus one markdown artifact per task). Goal mode never acts outside the machine: tasks that ask
for an outbound action (sending email, posting, payments, sign-ups, deployments) are turned into
draft artifacts for a human to review and execute.

### Goal mode contracts

Goal mode turns one high-level objective into a plan of role-based tasks and executes it
(see `Goal`, `GoalTask`, `GoalRole`, `GoalStatus` and `GoalLimits` in `types.ts`).

```ts
type GoalTaskKind = 'code' | 'artifact';
interface GoalTask {
  id: string;
  title: string;
  description?: string;
  role: string; // a GoalRole id: planner, researcher, implementer, reviewer, writer…
  kind: GoalTaskKind; // code → autonomous runner; artifact → markdown document
  status: TaskStatus; // PENDING | IN_PROGRESS | SUCCESS | FAILED
  dependsOn: string[];
  acceptance?: string[];
  round: number; // planning round that created it
  attempts: number;
  artifact?: string; // workspace-relative markdown path
  runnerTaskId?: string; // project task-graph id (code tasks)
  notes?: string;
}
type GoalStatus =
  | 'planning'
  | 'running'
  | 'reviewing'
  | 'planned'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'budget_exhausted';
interface Goal {
  id: string;
  objective: string;
  status: GoalStatus;
  round: number;
  limits: { maxRounds: number; maxTasks: number; maxTokens: number; tokensUsed: number };
  roles: GoalRole[];
  tasks: GoalTask[];
  activeTaskId?: string;
  summary?: string;
  lastError?: string;
  dryRun?: boolean;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}
```

Goal progress is streamed on `/api/events` as `goal.updated` (`{ goal: Goal }`, after every
state change) and `goal.log` (`{ goalId, level, message, role?, taskId? }`).

Configuration (`goal.*`, all optional):

| Key               | Default   | Meaning                                                                                 |
| :---------------- | :-------- | :-------------------------------------------------------------------------------------- |
| `route`           | `auto`    | Route or model id for roles without their own route                                     |
| `maxRounds`       | `4`       | Plan → execute → review rounds                                                          |
| `maxTasks`        | `12`      | Tasks across all rounds                                                                 |
| `maxTokens`       | `1000000` | Token cap across every agent call and runner pass                                       |
| `maxTaskAttempts` | `2`       | Attempts per task                                                                       |
| `codeTasks`       | `true`    | Hand `code` tasks to the autonomous runner; off → artifacts only                        |
| `roles`           | `{}`      | Extra or overridden roles: `{ "<id>": { description?, route?, instructions?, kind? } }` |

### Pane orchestrator

One objective is split by a planner agent into subtasks, and each subtask runs headlessly in a
vendor CLI the user is already signed in to (`claude` for Claude Code, `codex` for Codex, `agy`
for Antigravity), inside its own git worktree. Successful tasks are merged into an integration
branch that the user can apply. The contract lives in `packages/core/src/orchestrator/contract.ts`.

The routes exist only when the gateway was given an `OrchestratorService`. The runtime behind
`davecode start`, `davecode app`, `davecode chat` and the desktop app does that for its project
when it binds to loopback; if the service cannot be built it logs a `warn` event (scope
`orchestrator`) and starts without it. Without a service every route below answers
`404 not_found`. They need the gateway token like any other `/api` route, and `GET` responses
are sent with `Cache-Control: no-store`.

| Method | Path                                | Body            | Response                                       |
| :----- | :---------------------------------- | :-------------- | :--------------------------------------------- |
| `GET`  | `/api/orchestrator/agents`          | —               | `{ "agents": AgentAvailability[] }`            |
| `GET`  | `/api/orchestrator/runs`            | —               | `{ "runs": OrchestratorRun[] }` (newest first) |
| `POST` | `/api/orchestrator/runs`            | `StartRunInput` | `202 OrchestratorRun` (in `planning`)          |
| `GET`  | `/api/orchestrator/runs/:id`        | —               | `OrchestratorRun`                              |
| `POST` | `/api/orchestrator/runs/:id/cancel` | —               | `204`                                          |
| `POST` | `/api/orchestrator/runs/:id/apply`  | —               | `OrchestratorRun` (with `appliedAt`)           |

Runs are returned bare, not wrapped in `{ "run": … }`.

```ts
interface StartRunInput {
  objective: string; // 1–4000 chars, trimmed
  agents?: ('claude' | 'codex' | 'agy')[]; // 1–3; default: every available agent
  maxTasks?: number; // 1–8, default 5
  planner?: 'claude' | 'codex' | 'agy'; // must be installed; default: first allowed of claude, codex, agy
}
interface AgentAvailability {
  agent: 'claude' | 'codex' | 'agy';
  available: boolean; // its CLI is on PATH (sign-in is not checked)
}
```

Errors use the `/api` envelope with these codes:

| Status | Code               | When                                                                            |
| :----- | :----------------- | :------------------------------------------------------------------------------ |
| 400    | `invalid_body`     | The start body failed validation (the zod message is included)                  |
| 404    | `not_found`        | Unknown run id                                                                  |
| 409    | `no_agents`        | None of the requested agents is available                                       |
| 409    | `not_a_repository` | The project is not a git repository with at least one commit                    |
| 409    | `busy`             | Another run is active in this project (one at a time)                           |
| 409    | `not_appliable`    | Apply refused: the run is not `done`, was already applied, or the tree is dirty |
| 409    | `not_active`       | Cancel refused: the run is already over                                         |

Run status (`OrchestratorRunStatus`): `planning` (the planner is splitting the objective), then
`running` (tasks run or wait for their dependencies, at most 3 at a time), then `done` (every
task finished and the results are on the integration branch), `failed` (planning failed or no
task succeeded) or `cancelled`. Task status (`OrchestratorTaskStatus`): `pending`, `running`,
`done` (committed and merged into the integration branch), `failed`, `conflict` (finished, but
its branch conflicts with the integration branch, so it stays unmerged), `cancelled` and
`skipped` (a dependency did not finish). `error` fields are short and redacted, never a secret.

Git: a run starts from the current branch and commit (`baseBranch`, `baseCommit`). It creates the
integration branch `davecode/run-<id>` and one `davecode/run-<id>-<taskId>` branch per task, each
checked out in a worktree under `<DAVECODE_HOME>/worktrees/<project key>/<id>/<taskId>`, outside
the repository (the key is the first 16 hex digits of the SHA-256 of the project path). The
orchestrator never touches the user's working tree until `apply`, which merges the integration
branch into `baseBranch` and only when the tree is clean. It never pushes. Cleaning up a run
removes its worktrees but keeps the branches, so nothing an agent did is lost.

Progress is streamed on `/api/events` as:

- `orchestrator.run` (`{ run: OrchestratorRun }`): a full snapshot after every change.
- `orchestrator.output` (`{ runId, taskId, output: { kind, text } }`, `kind` one of `text`,
  `tool`, `status`, `error`): live activity of one task, or of the planner with `taskId`
  `"plan"`, already reduced to plain text.

From the terminal: `davecode orchestrate "<objective>" [--agents claude,codex,agy]
[--max-tasks <n>] [--apply]`, `davecode orchestrate --list` and
`davecode orchestrate --apply-run <id>` run the same service in-process.

### Live events

`GET /api/events` returns `text/event-stream`. Every event carries a strictly increasing
`id` (per gateway process). On connect the server replays the buffered events after the
client's cursor, taken from the `Last-Event-ID` header (sent automatically by `EventSource` on
reconnect) or a `?lastEventId=` query parameter; without one it replays the whole buffer. A
cursor higher than the latest id (the gateway restarted) also replays the whole buffer. Then
new events are streamed as they happen:

```
id: 42
event: request.completed
data: {"type":"request.completed","requestId":"req_…","ts":1760000000000,…}

```

The stream opens with `retry: 3000`. A comment line (`: ping`) is sent every 15 seconds as a
heartbeat.

`GET /api/logs?limit=200` returns `{ "events": DaveEvent[] }` from the same buffer, for clients
that prefer polling.

## DaveCode account

The account `davecode login` signs in to, as seen by the app running on the same machine.
Present only on a gateway bound to loopback; elsewhere these routes answer 404 and the dashboard
offers local mode. They need the gateway token like any other `/api` route. Tokens stay in the
encrypted store: `AccountState` carries `signedIn`, `user | null` (`id`, `email`, `name`,
`provider`), `pending` and a displayable `error | null`.

| Endpoint                   | Behavior                                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/account`         | No-store `AccountState`.                                                                                                                                                   |
| `POST /api/account/login`  | Body `{ provider?: "google" \| "github" }`. Opens the browser and answers `202 { url, opened }` without waiting. Without `provider`, opens the page offering every method. |
| `POST /api/account/cancel` | Stops waiting for a pending sign-in. `204`.                                                                                                                                |
| `POST /api/account/logout` | Signs out on this machine, the CLI included. `204`.                                                                                                                        |

## App sign-in

App identity is separate from model-provider accounts. `LoginProvider` is `google | github`;
`LoginUser` contains `id` (provider subject), `provider`, and `name` (no credentials).
`LoginStatus` contains `required`, configured `providers`, and `user | null`.

| Endpoint                           | Behavior                                                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/auth/session`            | Public, no-store `LoginStatus`; disabled login returns `required: false`.                                                                                         |
| `GET /api/auth/:provider/start`    | Google/GitHub redirect with browser-bound state and PKCE. Unconfigured providers return 503.                                                                      |
| `GET /api/auth/:provider/callback` | Consumes the authorization code, validates an allowed identity and sets an HttpOnly session cookie. Failures redirect to the sign-in screen with a generic error. |
| `POST /api/auth/logout`            | Revokes the session and clears its cookie. Requires the canonical Origin when login is enabled.                                                                   |

With app login enabled, `/api` accepts an allowed app session or the configured bearer
token. Cookie-authenticated writes require the exact configured Origin. `/v1` accepts
only the configured bearer token; a browser session never authorizes an SDK client.
Sessions expire after eight hours and on gateway restart. Auth endpoints are public
so an unauthenticated browser can sign in. Codes/state are redacted from request logs.
See [AUTH.md](AUTH.md) for environment configuration and same-origin deployment limits.
