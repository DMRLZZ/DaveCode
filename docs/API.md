# DaveCode HTTP API

The gateway listens on `http://127.0.0.1:4040` by default and exposes two surfaces:

| Prefix | Audience | Purpose |
| :----- | :------- | :------ |
| `/v1`  | Any OpenAI-compatible client (SDKs, editors, agents) | Chat completions with quota-aware routing and hot failover |
| `/api` | The DaveCode dashboard, TUI and scripts | Accounts, usage, routes, task graph, runner control, live events |

All shapes referenced below (`Account`, `AccountUsage`, `UsageRecord`, `Route`, `TaskGraph`,
`RunnerStatus`, `DaveEvent`, …) are defined in
[`packages/core/src/types.ts`](../packages/core/src/types.ts) and
[`packages/core/src/events.ts`](../packages/core/src/events.ts). They are the source of truth.

## Authentication

If `server.authToken` is configured, every `/v1` and `/api` request must send
`Authorization: Bearer <token>`. Because `EventSource` cannot set headers, `GET /api/events`
also accepts `?token=<token>`. With no token configured the gateway only binds to loopback
by default.

## Errors

- `/v1/*` uses the OpenAI error envelope:
  `{ "error": { "message": string, "type": string, "code": string | null } }`
- `/api/*` uses `{ "error": { "message": string, "code": string } }`

| Status | Meaning |
| :----- | :------ |
| 400 | Invalid body (zod validation message included, code `invalid_body`), or `experimental_disabled` |
| 401 | Missing/invalid bearer token (`invalid_api_key` on `/v1`, `unauthorized` on `/api`) |
| 404 | Unknown resource (`not_found`) or no account can serve the model (`model_not_found`) |
| 404 | also `task_not_found`: `POST /api/runner/start` named a task id that does not exist |
| 409 | The autonomous runner refused to start; `code` is the `RunnerError` code: `not_a_repo`, `no_brain`, `no_base_branch`, `dirty_worktree`, `invalid_graph`, `busy`, or for a targeted start `task_not_runnable` (the task is not `PENDING`) and `task_blocked` (it depends on unfinished tasks, which the message names) |
| 429 | Every candidate account is saturated or cooling down (`no_capacity`), or every attempt was rate limited upstream (`rate_limited`) |
| 501 | The autonomous runner is not available in this process (`runner_unavailable`) |
| 502 | All failover targets failed upstream (`upstream_failed`), or upstream credentials were rejected (`upstream_auth_error`) |
| 503 | Matching accounts exist but none is usable: disabled, in error or without an adapter (`no_available_account`) |

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

| Header | Description |
| :----- | :---------- |
| `x-davecode-request-id` | Correlates with `request.*` events and `UsageRecord.requestId` |
| `x-davecode-account` | Account id that finally served the request |
| `x-davecode-provider` | Provider kind that served the request |
| `x-davecode-failovers` | Number of failover hops taken |

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

| Method | Path | Body | Response |
| :----- | :--- | :--- | :------- |
| `GET` | `/api/accounts` | — | `{ "accounts": Account[] }` |
| `POST` | `/api/accounts` | `AccountCreate` | `201 { "account": Account }` |
| `PATCH` | `/api/accounts/:id` | `AccountPatch` | `{ "account": Account }` |
| `DELETE` | `/api/accounts/:id` | — | `204` |

```ts
interface AccountCreate {
  provider: ProviderKind;
  label: string;
  priority?: number;          // default 100
  weight?: number;            // default 1
  limits?: QuotaLimits;
  config?: Record<string, unknown>;
  secret?: string;            // API key / token — encrypted at rest, never returned
}
type AccountPatch = Partial<Omit<AccountCreate, 'provider'>> & { enabled?: boolean };
```

Secrets are write-only: no endpoint ever returns them. `Account.hasSecret` tells you whether one is stored. Creating a `gemini-web` account while
`experimental.geminiWeb` is off returns `400` with code `experimental_disabled`. Unknown body
fields and credential-like `config` keys (`apiKey`, `token`, `password`, `cookie`…) are rejected
with `400 invalid_body`; send credentials in `secret`. `AccountCreate` also accepts
`enabled?: boolean`.

`PATCH` with `enabled: false` sets `status: "disabled"`. `enabled: true` or a new `secret`
resets an enabled account to `active` and clears `cooldownUntil` and `lastError`.

### Usage

`GET /api/usage`

```json
{ "usage": AccountUsage[] }
```

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

### Project brain & task graph

`GET /api/tasks`

```json
{ "project": { "root": "/path/to/repo", "name": "repo" } | null, "graph": TaskGraph }
```

`GET /api/brain`

```json
{ "state": "<STATE.md markdown>", "architecture": "<ARCHITECTURE.md markdown>" }
```

### Autonomous runner

| Method | Path | Response |
| :----- | :--- | :------- |
| `GET` | `/api/runner` | `{ "status": RunnerStatus }` |
| `POST` | `/api/runner/start` | `{ "status": RunnerStatus }` |
| `POST` | `/api/runner/pause` | `{ "status": RunnerStatus }` |
| `POST` | `/api/runner/stop` | `{ "status": RunnerStatus }` |

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
`repairCycle`), `runner.log` (`{ level, message, taskId? }`) and `task.updated`.

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

| Key | Default | Meaning |
| :-- | :------ | :------ |
| `maxRepairCycles` | `3` | Repair passes after the first implementation before the task is `FAILED` |
| `branchPrefix` / `baseBranch` | `davecode/task-` / `main` | Task branches and merge target |
| `route` | `auto` | Route (`davecode/<route>`) or model id for the `builtin` executor |
| `executor` | `builtin` | `builtin` tool loop or `claude-cli` delegation |
| `pullRequests` | `false` | Push and `gh pr create` instead of merging locally (falls back to merge) |
| `commitBrain` | `true` | Commit STATE.md / TASK_GRAPH.json on the base branch after each task |
| `commandTimeoutMs` | `600000` | Timeout per validation command and per `run_command` |
| `idlePollMs` | `30000` | Sleep between polls when no task is ready |
| `maxIterations` | `40` | Model round-trips per implementation or repair pass |
| `maxTaskTokens` | `1500000` | Token budget per task across passes |
| `allowedCommands` | `pnpm npm npx node git tsc biome vitest` | Executables `run_command` may start |
| `claudeCli.accountId` / `model` / `allowedTools` / `timeoutMs` | first enabled account / CLI default / file tools + common `Bash(...)` / `1800000` | `claude-cli` executor settings |
| `validate.lint` / `typecheck` / `test` | unset | Quality-gate commands (split into argv, run without a shell) |
| `judge.kind` | `none` | `none`, `jev` (OpenRouter Decisions API, key from `OPENROUTER_API_KEY` or `JEV_API_KEY`) or `llm` |
| `judge.model` / `baseUrl` / `threshold` | `typesafe/jev-1.13` or `runner.route` / `https://openrouter.ai/api/alpha` / `0.7` | Judge model, Decisions API base URL, minimum confidence |

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
