import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createEngine, PROVIDER_KINDS, type ProviderKind } from '@davecode/core';
import { FakeProvider } from '@davecode/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GatewayClient, GatewayError, streamMeta } from './client';
import { startRuntime } from './runtime';
import { ChatStreamError, chatChunks, readSSE, type SSEMessage, SSEParser } from './sse';
import { type TempDir, tempDir, testEnv } from './test-utils';

async function* from<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe('SSEParser', () => {
  it('parses events, ids, retry, comments and multi-line data', () => {
    const parser = new SSEParser();
    const messages = parser.push(
      'retry: 3000\n: ping\nevent: request.completed\nid: 7\ndata: {"a":1}\n\ndata: line one\ndata: line two\n\n',
    );
    expect(messages).toEqual([
      { event: 'request.completed', data: '{"a":1}', id: '7', retry: 3000 },
      { event: 'message', data: 'line one\nline two', id: '7', retry: 3000 },
    ]);
  });

  it('handles CRLF and CR line endings split across chunks', () => {
    const parser = new SSEParser();
    const out: SSEMessage[] = [];
    for (const chunk of ['data: a\r', '\n\r', '\ndata: b\r\r', 'data:c\n', '\n']) {
      out.push(...parser.push(chunk));
    }
    expect(out.map((m) => m.data)).toEqual(['a', 'b', 'c']);
  });

  it('ignores events without data and discards an unterminated tail', () => {
    const parser = new SSEParser();
    expect(parser.push('event: x\n\nid: 1\n\n')).toEqual([]);
    expect(parser.push('data: incomplete')).toEqual([]);
    expect(parser.end()).toEqual([]);
  });

  it('strips exactly one leading space and accepts fields without a colon', () => {
    const parser = new SSEParser();
    expect(parser.push('data:  two spaces\ndata\n\n')[0]?.data).toBe(' two spaces\n');
  });

  it('decodes multi-byte characters split across byte chunks', async () => {
    const bytes = new TextEncoder().encode('data: héllo 👋\n\n');
    const chunks = [bytes.slice(0, 8), bytes.slice(8, 15), bytes.slice(15)];
    const messages = await collect(readSSE(from(chunks)));
    expect(messages.map((m) => m.data)).toEqual(['héllo 👋']);
  });
});

describe('chatChunks', () => {
  const chunk = (content: string) =>
    JSON.stringify({
      id: 'c',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'm',
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    });

  it('yields completion chunks until [DONE] and skips junk', async () => {
    const messages = [chunk('Hel'), 'not json', chunk('lo'), '[DONE]', chunk('after')].map(
      (data) => ({ event: 'message', data }),
    );
    const chunks = await collect(chatChunks(from(messages)));
    expect(chunks.map((c) => c.choices[0]?.delta.content)).toEqual(['Hel', 'lo']);
  });

  it('turns a mid-stream error frame into ChatStreamError', async () => {
    const messages = [
      { event: 'message', data: chunk('partial') },
      { event: 'message', data: '{"error":{"message":"upstream died","code":"upstream_failed"}}' },
    ];
    const iterator = chatChunks(from(messages));
    await iterator.next();
    await expect(iterator.next()).rejects.toMatchObject({
      name: 'ChatStreamError',
      code: 'upstream_failed',
    });
    expect(new ChatStreamError('x').code).toBeUndefined();
  });
});

describe('GatewayClient streaming against a local gateway', () => {
  let tmp: TempDir;
  beforeEach(() => {
    tmp = tempDir();
    mkdirSync(join(tmp.path, 'home'));
  });
  afterEach(() => tmp.cleanup());

  it('streams a chat completion and reports the serving account', async () => {
    const home = join(tmp.path, 'home');
    const fakes = new Map<ProviderKind, FakeProvider>();
    for (const kind of PROVIDER_KINDS) fakes.set(kind, new FakeProvider(kind, [`${kind}-model`]));
    const engine = createEngine({ home, env: testEnv(home), providers: fakes });
    const account = engine.accounts.create({
      provider: 'openai',
      label: 'work',
      config: { defaultModel: 'openai-model' },
    });
    fakes.get('openai')!.script(account.id, { type: 'stream', chunks: ['Hello', ', world'] });
    const runtime = await startRuntime({
      home,
      env: testEnv(home),
      cwd: tmp.path,
      host: '127.0.0.1',
      port: 0,
      dashboard: false,
      noProject: true,
      engine,
    });
    try {
      const client = new GatewayClient({ baseUrl: runtime.url });
      const { meta, chunks } = await client.chatStream({
        model: 'openai/openai-model',
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(meta).toMatchObject({ accountId: account.id, provider: 'openai', failovers: 0 });
      const text = (await collect(chunks)).map((c) => c.choices[0]?.delta.content ?? '').join('');
      expect(text).toBe('Hello, world');

      await expect(
        client.chatStream({ model: 'nope/unknown', messages: [{ role: 'user', content: 'x' }] }),
      ).rejects.toBeInstanceOf(GatewayError);
    } finally {
      await runtime.close();
    }
  });

  it('reads routing headers', () => {
    const headers = new Headers({
      'x-davecode-account': 'acc_1',
      'x-davecode-provider': 'anthropic',
      'x-davecode-failovers': '2',
      'x-davecode-request-id': 'req_1',
    });
    expect(streamMeta(headers)).toEqual({
      accountId: 'acc_1',
      provider: 'anthropic',
      failovers: 2,
      requestId: 'req_1',
    });
    expect(streamMeta(new Headers())).toEqual({ failovers: 0 });
  });

  it('reports an unreachable gateway as GatewayError with status 0', async () => {
    const client = new GatewayClient({ baseUrl: 'http://127.0.0.1:1' });
    await expect(client.get('/api/health')).rejects.toMatchObject({
      status: 0,
      code: 'unreachable',
    });
    expect(await client.health()).toBeUndefined();
  });
});
