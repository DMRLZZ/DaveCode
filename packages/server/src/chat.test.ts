import { ChatError, type ChatService, type ChatSession } from '@davecode/core';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGateway } from './gateway';
import { makeTestEngine, type TestEngine } from './test-utils';

let app: FastifyInstance | undefined;
let fixture: TestEngine | undefined;
afterEach(async () => {
  await app?.close();
  fixture?.cleanup();
  app = undefined;
  fixture = undefined;
});

const chat = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  id: 'c1',
  agent: 'claude',
  title: 'Retry',
  turns: [],
  createdAt: '2026-11-17T10:00:00.000Z',
  updatedAt: '2026-11-17T10:00:00.000Z',
  ...overrides,
});

function service(overrides: Partial<ChatService> = {}): ChatService {
  return {
    list: vi.fn(() => [chat()]),
    get: vi.fn((id: string) => (id === 'c1' ? chat() : undefined)),
    create: vi.fn(async (input) => chat({ id: 'c2', agent: input.agent })),
    send: vi.fn(async (id: string, input) => {
      if (id !== 'c1') throw new ChatError('not_found', 'No chat.');
      return chat({
        turns: [
          {
            id: 'm1',
            prompt: input.text,
            status: 'running',
            access: input.access ?? 'edit',
            startedAt: '2026-11-17T10:00:01.000Z',
          },
        ],
      });
    }),
    cancel: vi.fn(() => false),
    rename: vi.fn((id: string, title: string) => (id === 'c1' ? chat({ title }) : undefined)),
    remove: vi.fn((id: string) => id === 'c1'),
    transcript: vi.fn((id: string) =>
      id === 'c1'
        ? { m1: { from: 0, chunks: [{ kind: 'tool' as const, text: 'Edit a.ts' }] } }
        : undefined,
    ),
    patch: vi.fn((id: string, turn: string) => (id === 'c1' && turn === 'm1' ? '+x\n' : undefined)),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

async function setup(chatService?: ChatService) {
  fixture = makeTestEngine();
  app = await buildGateway(fixture.engine, {
    login: false,
    ...(chatService ? { chat: chatService } : {}),
  });
  return app;
}

const json = { 'content-type': 'application/json' };

describe('/api/chat', () => {
  it('does not exist without a chat service', async () => {
    const gateway = await setup();
    expect((await gateway.inject('/api/chat/sessions')).statusCode).toBe(404);
  });

  it('lists, reads, creates, renames and removes chats', async () => {
    const chats = service();
    const gateway = await setup(chats);
    const list = await gateway.inject('/api/chat/sessions');
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.json().sessions.map((s: ChatSession) => s.id)).toEqual(['c1']);
    expect((await gateway.inject('/api/chat/sessions/c1')).json()).toMatchObject({ id: 'c1' });
    expect((await gateway.inject('/api/chat/sessions/nope')).statusCode).toBe(404);

    const created = await gateway.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: json,
      payload: { agent: 'codex' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: 'c2', agent: 'codex' });

    const renamed = await gateway.inject({
      method: 'PATCH',
      url: '/api/chat/sessions/c1',
      headers: json,
      payload: { title: 'Retries' },
    });
    expect(renamed.json().title).toBe('Retries');

    const removed = await gateway.inject({ method: 'DELETE', url: '/api/chat/sessions/c1' });
    expect(removed.statusCode).toBe(204);
    expect(
      (await gateway.inject({ method: 'DELETE', url: '/api/chat/sessions/nope' })).statusCode,
    ).toBe(404);
  });

  it('validates what it is sent', async () => {
    const gateway = await setup(service());
    for (const [url, payload] of [
      ['/api/chat/sessions', { agent: 'gpt' }],
      ['/api/chat/sessions/c1/messages', { text: '' }],
      ['/api/chat/sessions/c1/messages', { text: 'x', access: 'root' }],
    ] as const) {
      const response = await gateway.inject({ method: 'POST', url, headers: json, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('invalid_body');
    }
  });

  it('sends a message and maps refusals', async () => {
    const chats = service();
    const gateway = await setup(chats);
    const sent = await gateway.inject({
      method: 'POST',
      url: '/api/chat/sessions/c1/messages',
      headers: json,
      payload: { text: 'Add retry', access: 'full' },
    });
    expect(sent.statusCode).toBe(202);
    expect(sent.json().turns[0]).toMatchObject({ prompt: 'Add retry', access: 'full' });
    expect(chats.send).toHaveBeenCalledWith('c1', { text: 'Add retry', access: 'full' });

    const missing = await gateway.inject({
      method: 'POST',
      url: '/api/chat/sessions/nope/messages',
      headers: json,
      payload: { text: 'x' },
    });
    expect(missing.statusCode).toBe(404);

    const busy = await setupBusy();
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe('busy');
  });

  it('cancels, and says so when nothing runs', async () => {
    const gateway = await setup(service({ cancel: vi.fn((id: string) => id === 'c1') }));
    const ok = await gateway.inject({
      method: 'POST',
      url: '/api/chat/sessions/c1/cancel',
      headers: json,
    });
    expect(ok.statusCode).toBe(204);
    await app?.close();
    const idle = await setup(service());
    const notActive = await idle.inject({
      method: 'POST',
      url: '/api/chat/sessions/c1/cancel',
      headers: json,
    });
    expect(notActive.statusCode).toBe(409);
    expect(notActive.json().error.code).toBe('not_active');
  });

  it('serves the transcript and a turn diff', async () => {
    const gateway = await setup(service());
    expect((await gateway.inject('/api/chat/sessions/c1/output')).json()).toEqual({
      output: { m1: { from: 0, chunks: [{ kind: 'tool', text: 'Edit a.ts' }] } },
    });
    expect((await gateway.inject('/api/chat/sessions/c1/turns/m1/patch')).json()).toEqual({
      patch: '+x\n',
    });
    expect((await gateway.inject('/api/chat/sessions/c1/turns/m9/patch')).statusCode).toBe(404);
    expect((await gateway.inject('/api/chat/sessions/nope/output')).statusCode).toBe(404);
  });
});

async function setupBusy() {
  await app?.close();
  const gateway = await setup(
    service({
      send: vi.fn(async () => {
        throw new ChatError('busy', 'The agent is still answering the last message.');
      }),
    }),
  );
  return gateway.inject({
    method: 'POST',
    url: '/api/chat/sessions/c1/messages',
    headers: json,
    payload: { text: 'x' },
  });
}
