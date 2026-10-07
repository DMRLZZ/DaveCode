import { describe, expect, it } from 'vitest';
import { plain } from '../test-utils';
import { chatReducer, initialChatState } from './chat-state';
import { statusSegments } from './components/StatusLine';
import { metaLine } from './components/Transcript';
import * as ed from './editor';
import { completeSlash, parseSlash, slashSuggestions } from './slash';

describe('editor', () => {
  it('inserts, deletes and moves by code point', () => {
    let s = ed.insert(ed.emptyEditor, 'héllo 👋');
    expect(ed.textOf(s)).toBe('héllo 👋');
    expect(s.cursor).toBe(7);
    s = ed.backspace(s);
    expect(ed.textOf(s)).toBe('héllo ');
    s = ed.left(ed.left(s));
    s = ed.insert(s, 'X');
    expect(ed.textOf(s)).toBe('héllXo ');
    s = ed.deleteForward(s);
    expect(ed.textOf(s)).toBe('héllX ');
  });

  it('normalises pasted text', () => {
    expect(ed.textOf(ed.insert(ed.emptyEditor, 'a\r\nb\rc\td\u0007'))).toBe('a\nb\nc  d');
  });

  it('moves between lines keeping the column, then reports the edges', () => {
    let s = ed.fromText('first line\nab\nthird');
    expect(ed.position(s)).toEqual({ line: 2, column: 5 });
    s = ed.up(s)!;
    expect(ed.position(s)).toEqual({ line: 1, column: 2 });
    s = ed.up(s)!;
    expect(ed.position(s)).toEqual({ line: 0, column: 2 });
    expect(ed.up(s)).toBeUndefined();
    s = ed.down(ed.down(s)!)!;
    expect(ed.position(s)).toEqual({ line: 2, column: 2 });
    expect(ed.down(s)).toBeUndefined();
    expect(ed.lineCount(s)).toBe(3);
  });

  it('supports line start/end, kill and word deletion', () => {
    let s = ed.fromText('hello big world');
    s = ed.deleteWordBack(s);
    expect(ed.textOf(s)).toBe('hello big ');
    s = ed.lineStart(s);
    expect(s.cursor).toBe(0);
    s = ed.killToLineEnd(ed.right(s));
    expect(ed.textOf(s)).toBe('h');
    s = ed.killToLineStart(ed.lineEnd(ed.fromText('one\ntwo')));
    expect(ed.textOf(s)).toBe('one\n');
  });

  it('turns a trailing backslash into a new line', () => {
    const s = ed.fromText('line one\\');
    expect(ed.continuesLine(s)).toBe(true);
    expect(ed.textOf(ed.newlineAfterBackslash(s))).toBe('line one\n');
    expect(ed.continuesLine(ed.fromText('plain'))).toBe(false);
  });
});

describe('slash commands', () => {
  it('parses commands, aliases and arguments', () => {
    expect(parseSlash('/model  anthropic/claude-sonnet-5-5 ')).toMatchObject({
      kind: 'command',
      command: { name: 'model' },
      args: 'anthropic/claude-sonnet-5-5',
    });
    expect(parseSlash('/quit')).toMatchObject({ kind: 'command', command: { name: 'exit' } });
    expect(parseSlash('/nope')).toEqual({ kind: 'unknown', name: 'nope' });
    expect(parseSlash('hello /model')).toEqual({ kind: 'none' });
    expect(parseSlash('//not a command')).toEqual({ kind: 'none' });
  });

  it('suggests and completes while typing the name', () => {
    expect(slashSuggestions('/').length).toBeGreaterThan(5);
    expect(slashSuggestions('/st').map((c) => c.name)).toEqual(['status']);
    expect(slashSuggestions('/model x')).toEqual([]);
    expect(completeSlash('/mo')).toBe('/model ');
    expect(completeSlash('/cl')).toBe('/clear');
    expect(completeSlash('/zz')).toBeUndefined();
  });
});

describe('chat reducer', () => {
  const start = initialChatState('davecode/auto');

  it('streams a reply into the transcript and the conversation', () => {
    let s = chatReducer(start, { type: 'user', text: 'hi' });
    s = chatReducer(s, { type: 'stream-start', now: 1000 });
    s = chatReducer(s, {
      type: 'stream-meta',
      accountId: 'acc_1',
      accountLabel: 'work',
      provider: 'anthropic',
      failovers: 1,
    });
    s = chatReducer(s, { type: 'stream-delta', text: 'Hel' });
    s = chatReducer(s, { type: 'stream-delta', text: 'lo' });
    expect(s.streaming?.text).toBe('Hello');
    s = chatReducer(s, {
      type: 'stream-end',
      now: 2500,
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });
    expect(s.streaming).toBeUndefined();
    expect(s.entries.map((e) => e.kind)).toEqual(['user', 'assistant']);
    expect(s.entries[1]?.meta).toMatchObject({
      accountLabel: 'work',
      provider: 'anthropic',
      tokens: 12,
      latencyMs: 1500,
      failovers: 1,
    });
    expect(s.conversation).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello' },
    ]);
    expect(s.tokens).toEqual({ prompt: 10, completion: 2 });
    expect(s.lastAccount).toEqual({ id: 'acc_1', label: 'work', provider: 'anthropic' });
    expect(s.totalFailovers).toBe(1);
    expect(s.history).toEqual(['hi']);
  });

  it('keeps cancelled output visible but out of the conversation', () => {
    let s = chatReducer(start, { type: 'user', text: 'long question' });
    s = chatReducer(s, { type: 'stream-start', now: 0 });
    s = chatReducer(s, { type: 'stream-delta', text: 'partial' });
    s = chatReducer(s, { type: 'stream-end', now: 10, cancelled: true });
    expect(s.entries[1]).toMatchObject({
      kind: 'assistant',
      text: 'partial',
      meta: { cancelled: true },
    });
    expect(s.conversation).toEqual([]);
    expect(s.entries[1]?.meta?.estimated).toBe(true);
  });

  it('records errors and clears the transcript on /clear', () => {
    let s = chatReducer(start, { type: 'user', text: 'q' });
    s = chatReducer(s, { type: 'stream-start', now: 0 });
    s = chatReducer(s, { type: 'stream-end', now: 5, error: 'no_capacity' });
    expect(s.entries.map((e) => e.kind)).toEqual(['user', 'error']);
    expect(s.conversation).toEqual([]);
    s = chatReducer(s, { type: 'clear' });
    expect(s.entries).toEqual([]);
    expect(s.epoch).toBe(1);
    expect(s.history).toEqual(['q']);
  });

  it('tracks the 5h quota of the last account only', () => {
    let s = chatReducer(start, { type: 'stream-start', now: 0 });
    s = chatReducer(s, { type: 'stream-meta', accountId: 'acc_1' });
    s = chatReducer(s, { type: 'quota', accountId: 'acc_2', utilization: 0.9 });
    expect(s.quota5h).toBeUndefined();
    s = chatReducer(s, { type: 'quota', accountId: 'acc_1', utilization: 0.42 });
    expect(s.quota5h).toBe(0.42);
  });
});

describe('status line', () => {
  const state = {
    ...initialChatState('davecode/auto'),
    connection: 'online' as const,
    lastAccount: { id: 'acc_1', label: 'work', provider: 'claude-cli' },
    lastFailovers: 1,
    totalFailovers: 2,
    tokens: { prompt: 1200, completion: 340 },
    quota5h: 0.23,
  };
  const info = { where: 'in-process 54012', inProcess: true };

  it('shows model, account, failovers, tokens, quota and connection', () => {
    const { left, right } = statusSegments(plain, state, info, 200);
    expect(left).toBe(
      'davecode/auto · work (claude-cli) · 1/2 failovers · 1.2k↑ 340↓ · 5h █░░░░░ 23%',
    );
    expect(right).toBe('● in-process 54012');
  });

  it('drops tokens, then quota, then failovers in narrow terminals', () => {
    expect(statusSegments(plain, state, info, 70).left).toBe(
      'davecode/auto · work (claude-cli) · 1/2 failovers',
    );
    expect(statusSegments(plain, state, info, 55).left).toBe('davecode/auto · work (claude-cli)');
    expect(statusSegments(plain, state, info, 30).left).toBe('davecode/auto');
    const offline = statusSegments(plain, { ...state, connection: 'offline' }, info, 200);
    expect(offline.right).toBe('● offline');
    expect(statusSegments(plain, state, { ...info, notice: 'Press Ctrl+C again' }, 200).right).toBe(
      'Press Ctrl+C again',
    );
  });

  it('formats the reply meta line', () => {
    expect(
      metaLine({
        provider: 'openai',
        accountLabel: 'personal',
        model: 'davecode/auto',
        tokens: 1234,
        estimated: true,
        latencyMs: 830,
        failovers: 2,
      }),
    ).toBe('openai · personal · davecode/auto · ~1.2k tok · 0.8s · 2 failovers');
  });
});
