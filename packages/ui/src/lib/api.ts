import { connectEventStream, type StreamHandlers } from './events';
import type {
  Account,
  AccountCreate,
  AccountPatch,
  AccountUsage,
  ApiErrorBody,
  BrainResponse,
  DaveEvent,
  HealthResponse,
  ModelInfo,
  RoutesResponse,
  RunnerStatus,
  TasksResponse,
  TimeseriesBucket,
  UsageRecord,
} from './types';

/** Error thrown for every non-2xx response or transport failure. */
export class ApiError extends Error {
  /** HTTP status, or 0 when the gateway could not be reached at all. */
  readonly status: number;
  /** `/api` error code (e.g. `experimental_disabled`, `runner_unavailable`) or a transport code. */
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  /** True when the DaveCode gateway itself answered (even with an error). */
  get reachable(): boolean {
    return this.status > 0 && !UNREACHABLE_CODES.has(this.code);
  }
}

/** Transport-level codes: something other than the gateway answered, or nothing did. */
const UNREACHABLE_CODES = new Set(['network', 'bad_response', 'gateway_unreachable']);

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

export type RunnerAction = 'start' | 'pause' | 'stop';

/**
 * Everything the dashboard can ask of the gateway. Implemented by the HTTP client below and
 * by the in-browser mock (`./mock`), so every screen is agnostic to the data source.
 */
export interface DaveClient {
  readonly mode: 'live' | 'mock';
  health(): Promise<HealthResponse>;
  listAccounts(): Promise<Account[]>;
  createAccount(body: AccountCreate): Promise<Account>;
  updateAccount(id: string, patch: AccountPatch): Promise<Account>;
  deleteAccount(id: string): Promise<void>;
  usage(): Promise<AccountUsage[]>;
  timeseries(minutes?: number, bucketSec?: number): Promise<TimeseriesBucket[]>;
  requests(limit?: number): Promise<UsageRecord[]>;
  routes(): Promise<RoutesResponse>;
  tasks(): Promise<TasksResponse>;
  brain(): Promise<BrainResponse>;
  runner(): Promise<RunnerStatus>;
  runnerAction(action: RunnerAction): Promise<RunnerStatus>;
  logs(limit?: number): Promise<DaveEvent[]>;
  /** `GET /v1/models`: every model of every enabled account plus `davecode/<route>` aliases. */
  models(): Promise<ModelInfo[]>;
  /** Subscribe to `/api/events`. Returns an unsubscribe function. */
  subscribe(handlers: StreamHandlers): () => void;
}

export interface HttpClientOptions {
  /** Gateway origin; empty string = same origin. */
  baseUrl: string;
  token: string;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

export function createHttpClient({ baseUrl, token }: HttpClientOptions): DaveClient {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await fetch(joinUrl(baseUrl, path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError(0, 'network', `Gateway unreachable: ${(e as Error).message}`);
    }

    if (res.status === 204) return undefined as T;

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // A proxy error page or the Vite index.html: the gateway is not what answered.
      throw new ApiError(
        res.ok ? 0 : res.status,
        'bad_response',
        `Unexpected non-JSON response from ${path}`,
      );
    }

    if (!res.ok) {
      const err = (json as Partial<ApiErrorBody> | undefined)?.error;
      // A 502/503/504 without the /api error envelope comes from a proxy (Vite dev/preview,
      // a reverse proxy) that could not reach the gateway, not from the gateway itself.
      if (!err && res.status >= 502 && res.status <= 504) {
        throw new ApiError(
          res.status,
          'gateway_unreachable',
          `Gateway unreachable (proxy answered ${res.status})`,
        );
      }
      throw new ApiError(
        res.status,
        err?.code ?? `http_${res.status}`,
        err?.message ?? `${method} ${path} failed with ${res.status}`,
      );
    }
    return json as T;
  }

  const get = <T>(path: string) => request<T>('GET', path);

  return {
    mode: 'live',
    health: () => get<HealthResponse>('/api/health'),
    listAccounts: async () => (await get<{ accounts: Account[] }>('/api/accounts')).accounts,
    createAccount: async (body) =>
      (await request<{ account: Account }>('POST', '/api/accounts', body)).account,
    updateAccount: async (id, patch) =>
      (
        await request<{ account: Account }>(
          'PATCH',
          `/api/accounts/${encodeURIComponent(id)}`,
          patch,
        )
      ).account,
    deleteAccount: (id) => request<void>('DELETE', `/api/accounts/${encodeURIComponent(id)}`),
    usage: async () => (await get<{ usage: AccountUsage[] }>('/api/usage')).usage,
    timeseries: async (minutes = 60, bucketSec = 60) =>
      (
        await get<{ buckets: TimeseriesBucket[] }>(
          `/api/usage/timeseries?minutes=${minutes}&bucketSec=${bucketSec}`,
        )
      ).buckets,
    requests: async (limit = 100) =>
      (await get<{ requests: UsageRecord[] }>(`/api/requests?limit=${limit}`)).requests,
    routes: () => get<RoutesResponse>('/api/routes'),
    tasks: () => get<TasksResponse>('/api/tasks'),
    brain: () => get<BrainResponse>('/api/brain'),
    runner: async () => (await get<{ status: RunnerStatus }>('/api/runner')).status,
    runnerAction: async (action) =>
      (await request<{ status: RunnerStatus }>('POST', `/api/runner/${action}`)).status,
    logs: async (limit = 200) =>
      (await get<{ events: DaveEvent[] }>(`/api/logs?limit=${limit}`)).events,
    models: async () => (await get<{ data: ModelInfo[] }>('/v1/models')).data,
    subscribe: (handlers) => {
      const qs = token ? `?token=${encodeURIComponent(token)}` : '';
      return connectEventStream(joinUrl(baseUrl, `/api/events${qs}`), handlers);
    },
  };
}

/** Human-readable message for any thrown value. */
export function errorMessage(e: unknown): string {
  if (isApiError(e)) {
    if (e.status === 401) return 'Unauthorized: set the gateway token in Settings.';
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
