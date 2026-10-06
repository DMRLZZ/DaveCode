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

Secrets are write-only: no endpoint ever returns them. Creating a `gemini-web` account while
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
boundaries and zero-filled; `tokens` is prompt + completion.

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

Most recent first.

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

When the gateway runs without a project brain, `/api/tasks` returns `project: null` with an
empty graph and `/api/brain` returns empty strings. Without a runner, `GET /api/runner` returns
`{ "status": { "state": "idle" } }` and the control endpoints return `501 runner_unavailable`.

### Live events

`GET /api/events` returns `text/event-stream`. On connect, the server replays the recent event
buffer, then streams new events as they happen:

```
event: request.completed
data: {"type":"request.completed","requestId":"req_…","ts":1760000000000,…}

```

The stream opens with `retry: 3000`. A comment line (`: ping`) is sent every 15 seconds as a
heartbeat.

`GET /api/logs?limit=200` returns `{ "events": DaveEvent[] }` from the same buffer, for clients
that prefer polling.
