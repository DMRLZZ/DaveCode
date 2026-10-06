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
| 400 | Invalid body (zod validation message included) |
| 401 | Missing/invalid bearer token |
| 404 | Unknown resource |
| 429 | Every candidate account is saturated or cooling down |
| 502 | All failover targets failed upstream |

---

## OpenAI-compatible surface (`/v1`)

### `GET /v1/models`

```json
{ "object": "list", "data": [ModelInfo, ...] }
```

Includes every model of every enabled account plus one entry per configured route, exposed as
`davecode/<route-name>` (e.g. `davecode/auto`), with `owned_by: "davecode"`.

### `POST /v1/chat/completions`

Body: `ChatRequest`. The `model` field accepts:

1. `davecode/<route>`: use a configured route (ordered failover targets).
2. `<provider>/<model>`, e.g. `anthropic/claude-sonnet-5-5`: any account of that provider.
3. A bare model id: the first enabled account that lists it.

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
`experimental.geminiWeb` is off returns `400` with code `experimental_disabled`.

### Usage

`GET /api/usage`

```json
{ "usage": AccountUsage[] }
```

`GET /api/usage/timeseries?minutes=60&bucketSec=60`

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

### Live events

`GET /api/events` returns `text/event-stream`. On connect, the server replays the recent event
buffer, then streams new events as they happen:

```
event: request.completed
data: {"type":"request.completed","requestId":"req_…","ts":1760000000000,…}

```

A comment line (`: ping`) is sent every 15 seconds as a heartbeat.

`GET /api/logs?limit=200` returns `{ "events": DaveEvent[] }` from the same buffer, for clients
that prefer polling.
