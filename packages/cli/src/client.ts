import type { DaveConfig } from '@davecode/core';

/**
 * Thin HTTP client for a running DaveCode gateway (`/api/*`, `/v1/*`). Used by `status`,
 * `accounts`, the chat TUI and the runner view. Never logs request bodies (they may carry
 * account secrets).
 */

export interface GatewayTarget {
  /** e.g. `http://127.0.0.1:4040` (no trailing slash). */
  baseUrl: string;
  token?: string;
}

export interface HealthResponse {
  status: string;
  version: string;
  uptimeSec: number;
  experimental: { geminiWeb: boolean; multiAccountRotation: boolean };
}

export type FetchLike = typeof fetch;

/** An `/api` or `/v1` error response, or a transport failure (`status` 0). */
export class GatewayError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
  }
}

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '']);

/** Host to connect to for a configured bind address (wildcards resolve to loopback). */
export function connectHost(host: string): string {
  if (WILDCARD_HOSTS.has(host)) return '127.0.0.1';
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
}

export function targetFor(config: DaveConfig, port = config.server.port): GatewayTarget {
  const target: GatewayTarget = { baseUrl: `http://${connectHost(config.server.host)}:${port}` };
  if (config.server.authToken) target.token = config.server.authToken;
  return target;
}

async function errorFrom(res: Response): Promise<GatewayError> {
  let code = `http_${res.status}`;
  let message = `${res.status} ${res.statusText}`.trim();
  try {
    const body = (await res.json()) as { error?: { message?: string; code?: string | null } };
    if (body.error?.message) message = body.error.message;
    if (body.error?.code) code = body.error.code;
  } catch {
    // Not JSON; keep the status line.
  }
  return new GatewayError(res.status, code, message);
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class GatewayClient {
  readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: FetchLike;

  constructor(target: GatewayTarget, fetchImpl: FetchLike = fetch) {
    this.baseUrl = target.baseUrl.replace(/\/+$/, '');
    this.token = target.token;
    this.fetchImpl = fetchImpl;
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}`, ...extra } : extra;
  }

  /** Low-level fetch with auth, an optional timeout and transport errors as `GatewayError`. */
  async fetch(path: string, init: RequestInit = {}, options: RequestOptions = {}) {
    const signals: AbortSignal[] = [];
    if (options.signal) signals.push(options.signal);
    if (options.timeoutMs !== undefined) signals.push(AbortSignal.timeout(options.timeoutMs));
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: this.headers((init.headers as Record<string, string> | undefined) ?? {}),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (options.signal?.aborted) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new GatewayError(
        0,
        'unreachable',
        `Cannot reach the gateway at ${this.baseUrl} (${reason})`,
      );
    }
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { 'content-type': 'application/json' };
    }
    const res = await this.fetch(path, init, { timeoutMs: 10_000, ...options });
    if (!res.ok) throw await errorFrom(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, options);
  }

  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, body, options);
  }

  patch<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PATCH', path, body, options);
  }

  delete(path: string, options?: RequestOptions): Promise<void> {
    return this.request<void>('DELETE', path, undefined, options);
  }

  /**
   * `GET /api/health`, or `undefined` when nothing (or something that is not DaveCode) answers.
   * Throws `GatewayError` 401 when a gateway is running but rejects our bearer token.
   */
  async health(timeoutMs = 800): Promise<HealthResponse | undefined> {
    let res: Response;
    try {
      res = await this.fetch('/api/health', {}, { timeoutMs });
    } catch {
      return undefined;
    }
    if (res.status === 401) {
      throw new GatewayError(
        401,
        'unauthorized',
        `The gateway at ${this.baseUrl} requires a bearer token`,
      );
    }
    if (!res.ok) return undefined;
    try {
      const body = (await res.json()) as Partial<HealthResponse>;
      return body.status === 'ok' && typeof body.version === 'string'
        ? (body as HealthResponse)
        : undefined;
    } catch {
      return undefined;
    }
  }
}

/** A client for the configured gateway if one is answering `/api/health`, else `undefined`. */
export async function findGateway(
  config: DaveConfig,
  options: { port?: number; fetch?: FetchLike; timeoutMs?: number } = {},
): Promise<{ client: GatewayClient; health: HealthResponse } | undefined> {
  const client = new GatewayClient(targetFor(config, options.port), options.fetch);
  const health = await client.health(options.timeoutMs);
  return health ? { client, health } : undefined;
}
