/** Helpers for adapter tests: a fake ProviderCallContext and a stubbed global fetch. */
import { vi } from 'vitest';
import type { Account, ChatCompletionChunk, ProviderCallContext, ProviderKind } from '../../types';

export function makeCtx(
  provider: ProviderKind,
  config: Record<string, unknown> = {},
  opts: { secret?: string; sandboxDir?: string; signal?: AbortSignal } = {},
): ProviderCallContext {
  const account: Account = {
    id: 'acc-1',
    provider,
    label: 'test',
    enabled: true,
    priority: 0,
    weight: 1,
    limits: {},
    config,
    status: 'active',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  return {
    account,
    secret: opts.secret ?? 'test-secret-key',
    sandboxDir: opts.sandboxDir ?? '.',
    signal: opts.signal,
  };
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type FetchHandler = (call: RecordedCall) => Response | Promise<Response>;

/** Replace global fetch; returns the list of calls made. Call `vi.unstubAllGlobals()` after. */
export function stubFetch(handler: FetchHandler): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: raw ? (JSON.parse(raw) as unknown) : undefined,
    };
    calls.push(call);
    const signal = init?.signal;
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return handler(call);
  });
  return calls;
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Build an SSE response; each item is a raw event block (string) already formatted. */
export function sseResponse(blocks: string[], splitAt?: number): Response {
  const text = blocks.join('');
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  const cut = splitAt ?? bytes.length;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, cut));
      if (cut < bytes.length) controller.enqueue(bytes.slice(cut));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export function sse(data: unknown, event?: string): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `${event ? `event: ${event}\n` : ''}data: ${payload}\n\n`;
}

export async function collect(
  iterable: AsyncIterable<ChatCompletionChunk>,
): Promise<ChatCompletionChunk[]> {
  const out: ChatCompletionChunk[] = [];
  for await (const c of iterable) out.push(c);
  return out;
}

/** Concatenate text deltas and tool-call argument deltas from a chunk list. */
export function summarizeChunks(chunks: ChatCompletionChunk[]) {
  let text = '';
  const toolCalls = new Map<number, { id?: string; name?: string; args: string }>();
  let finish: string | null = null;
  let usage: ChatCompletionChunk['usage'];
  for (const c of chunks) {
    if (c.usage) usage = c.usage;
    for (const choice of c.choices) {
      if (choice.delta.content && typeof choice.delta.content === 'string') {
        text += choice.delta.content;
      }
      for (const tc of (choice.delta as { tool_calls?: unknown[] }).tool_calls ?? []) {
        const t = tc as {
          index: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        };
        const cur = toolCalls.get(t.index) ?? { args: '' };
        if (t.id) cur.id = t.id;
        if (t.function?.name) cur.name = t.function.name;
        if (t.function?.arguments) cur.args += t.function.arguments;
        toolCalls.set(t.index, cur);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  return {
    text,
    toolCalls: [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]),
    finish,
    usage,
  };
}
