import { type ErrorScope, errorFromHttp, toProviderError } from './errors';
import { bodyChunks } from './lines';

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

/** fetch + uniform error mapping. Returns only successful (2xx) responses. */
export async function send(req: HttpRequest, scope: ErrorScope): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(req.url, {
      method: req.method ?? 'POST',
      headers: {
        ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...req.headers,
      },
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      signal: req.signal,
    });
  } catch (err) {
    throw toProviderError(err, scope, req.signal);
  }
  if (!res.ok) {
    let text = '';
    try {
      text = await res.text();
    } catch {
      // ignore body read errors; the status is what matters
    }
    throw errorFromHttp(res.status, text, res.headers, scope);
  }
  return res;
}

export async function sendJson(req: HttpRequest, scope: ErrorScope): Promise<unknown> {
  const res = await send(req, scope);
  try {
    return (await res.json()) as unknown;
  } catch (err) {
    throw toProviderError(err, scope, req.signal);
  }
}

/** Iterate a response body, converting stream failures into ProviderErrors. */
export async function* guardedBody(
  res: Response,
  scope: ErrorScope,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  try {
    yield* bodyChunks(res.body);
  } catch (err) {
    throw toProviderError(err, scope, signal);
  }
}
