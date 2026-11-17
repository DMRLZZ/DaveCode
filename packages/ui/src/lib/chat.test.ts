import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyChatEvent,
  ChatStore,
  cancelChat,
  chatOutputLines,
  EMPTY_CHAT_STATE,
  hydrateChats,
  isChatBusy,
  listChats,
  sendChat,
  sortedChats,
} from './chat';
import type { ChatSession, DaveEvent } from './types';

afterEach(() => {
  vi.unstubAllGlobals();
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

const output = (seq: number, text: string, turnId = 'm1'): DaveEvent => ({
  type: 'chat.output',
  sessionId: 'c1',
  turnId,
  output: { kind: 'tool', text },
  seq,
  ts: 1,
});

describe('chat state', () => {
  it('takes snapshots, removals and output', () => {
    let state = applyChatEvent(EMPTY_CHAT_STATE, { type: 'chat.session', session: chat(), ts: 1 });
    state = applyChatEvent(state, output(0, 'Read a.ts'));
    state = applyChatEvent(state, output(1, 'Edit a.ts'));
    // A chunk seen before is not repeated.
    expect(applyChatEvent(state, output(1, 'Edit a.ts'))).toBe(state);
    expect(chatOutputLines(state, 'c1', 'm1').map((l) => l.text)).toEqual([
      'Read a.ts',
      'Edit a.ts',
    ]);
    state = applyChatEvent(state, { type: 'chat.removed', sessionId: 'c1', ts: 2 });
    expect(state.sessions).toEqual({});
    expect(applyChatEvent(state, { type: 'chat.removed', sessionId: 'c1', ts: 3 })).toBe(state);
  });

  it('keeps the newer of a fetched chat and one from an event, newest first', () => {
    const newer = chat({ title: 'new', updatedAt: '2026-11-17T11:00:00.000Z' });
    const state = applyChatEvent(EMPTY_CHAT_STATE, { type: 'chat.session', session: newer, ts: 1 });
    expect(hydrateChats(state, [chat({ title: 'old' })])).toBe(state);
    const both = hydrateChats(state, [chat({ id: 'c2', updatedAt: '2026-11-17T12:00:00.000Z' })]);
    expect(sortedChats(both).map((c) => c.id)).toEqual(['c2', 'c1']);
  });

  it('knows when the agent is still answering', () => {
    const turn = { id: 'm1', prompt: 'x', access: 'edit' as const, startedAt: 'now' };
    expect(isChatBusy(chat({ turns: [{ ...turn, status: 'running' }] }))).toBe(true);
    expect(isChatBusy(chat({ turns: [{ ...turn, status: 'done' }] }))).toBe(false);
    expect(isChatBusy(chat())).toBe(false);
  });

  it('merges a transcript under live output in the store', () => {
    const store = new ChatStore(0);
    store.upsert(chat());
    store.ingest(output(2, 'third') as Extract<DaveEvent, { type: 'chat.output' }>);
    store.flush();
    store.hydrateTranscript('c1', {
      m1: {
        from: 0,
        chunks: [
          { kind: 'tool', text: 'first' },
          { kind: 'tool', text: 'second' },
          { kind: 'tool', text: 'third' },
        ],
      },
    });
    expect(chatOutputLines(store.getState(), 'c1', 'm1').map((l) => l.text)).toEqual([
      'first',
      'second',
      'third',
    ]);
    store.remove('c1');
    expect(store.getState().sessions).toEqual({});
  });
});

describe('chat client', () => {
  it('treats a gateway without chats as having none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: { code: 'not_found' } }, { status: 404 })),
    );
    expect(await listChats('http://gw', 't')).toBeNull();
  });

  it('sends a message and ignores a cancel for a chat that already stopped', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json(chat({ turns: [] }), { status: 202 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await sendChat('http://gw/', 't', 'c 1', 'hi', 'full');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://gw/api/chat/sessions/c%201/messages');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      text: 'hi',
      access: 'full',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: { code: 'not_active' } }, { status: 409 })),
    );
    await expect(cancelChat('http://gw', 't', 'c1')).resolves.toBeUndefined();
  });
});
