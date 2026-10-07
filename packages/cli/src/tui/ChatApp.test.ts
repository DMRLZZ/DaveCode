import type { Account, ChatCompletionChunk, ChatRequest } from '@davecode/core';
import { render } from 'ink-testing-library';
import { createElement as h } from 'react';
import { describe, expect, it } from 'vitest';
import { plain } from '../test-utils';
import type { ChatBackend } from './backend';
import { ChatApp } from './ChatApp';

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function chunk(content: string): ChatCompletionChunk {
  return {
    id: 'c',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'm',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
}

const account: Account = {
  id: 'acc_1',
  provider: 'anthropic',
  label: 'work',
  enabled: true,
  priority: 100,
  weight: 1,
  limits: { tokens5h: 1000 },
  config: {},
  status: 'active',
  createdAt: '',
  updatedAt: '',
};

function fakeBackend(
  stream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<ChatCompletionChunk>,
) {
  const requests: ChatRequest[] = [];
  const backend: ChatBackend = {
    url: 'http://127.0.0.1:4999',
    inProcess: true,
    health: async () => ({
      status: 'ok',
      version: '0.1.0',
      uptimeSec: 5,
      experimental: { geminiWeb: false, multiAccountRotation: false },
    }),
    stream: async (req, signal) => {
      requests.push(req);
      return {
        meta: { accountId: 'acc_1', provider: 'anthropic', failovers: 1 },
        chunks: stream(req, signal),
      };
    },
    models: async () => [
      { id: 'davecode/auto', object: 'model', created: 0, owned_by: 'davecode' },
      { id: 'claude-sonnet-5-5', object: 'model', created: 0, owned_by: 'anthropic' },
    ],
    routes: async () => ({
      defaultRoute: 'auto',
      routes: [{ name: 'auto', targets: [{ provider: 'anthropic', model: 'claude-sonnet-5-5' }] }],
    }),
    accounts: async () => [account],
    usage: async () => [
      {
        accountId: 'acc_1',
        windows: {
          '1m': { window: '1m', tokens: 0, requests: 0, utilization: 0 },
          '5h': { window: '5h', tokens: 250, requests: 1, tokenLimit: 1000, utilization: 0.25 },
          '24h': { window: '24h', tokens: 250, requests: 1, utilization: 0 },
        },
      },
    ],
    tasks: async () => ({ project: null, graph: { version: 1, tasks: [] } }),
    runner: async () => ({ state: 'idle' }),
  };
  return { backend, requests };
}

function mount(backend: ChatBackend) {
  return render(
    h(ChatApp, { backend, theme: plain, model: 'davecode/auto', version: '0.1.0', pollMs: 60_000 }),
  );
}

async function type(ui: ReturnType<typeof mount>, text: string) {
  ui.stdin.write(text);
  await tick();
}

describe('ChatApp', () => {
  it('streams a reply and shows the serving account, failovers and 5h quota', async () => {
    const { backend, requests } = fakeBackend(async function* () {
      yield chunk('Hello');
      await tick(10);
      yield chunk(' there');
    });
    const ui = mount(backend);
    await tick();
    expect(ui.lastFrame()).toContain('Ask anything');
    await type(ui, 'hi');
    await type(ui, '\r');
    await tick(80);
    const frame = ui.frames.join('\n');
    expect(frame).toContain('Hello there');
    expect(frame).toContain('anthropic · work');
    expect(ui.lastFrame()).toContain('work (anthropic)');
    expect(ui.lastFrame()).toContain('1/1 failovers');
    expect(ui.lastFrame()).toContain('5h');
    expect(ui.lastFrame()).toContain('25%');
    expect(ui.lastFrame()).toContain('in-process 4999');
    expect(requests[0]).toEqual({
      model: 'davecode/auto',
      messages: [{ role: 'user', content: 'hi' }],
    });
    ui.unmount();
  });

  it('inserts a newline with Ctrl+J instead of sending', async () => {
    const { backend, requests } = fakeBackend(async function* () {
      yield chunk('ok');
    });
    const ui = mount(backend);
    await tick();
    await type(ui, 'one');
    await type(ui, '\n');
    await type(ui, 'two');
    expect(requests).toHaveLength(0);
    expect(ui.lastFrame()).toContain('› one');
    expect(ui.lastFrame()).toContain('  two');
    await type(ui, '\r');
    await tick(50);
    expect(requests[0]?.messages[0]?.content).toBe('one\ntwo');
    ui.unmount();
  });

  it('cancels an in-flight reply with Esc', async () => {
    const { backend } = fakeBackend(async function* (_req, signal) {
      yield chunk('partial');
      await new Promise((resolve) => signal.addEventListener('abort', resolve));
    });
    const ui = mount(backend);
    await tick();
    await type(ui, 'go');
    await type(ui, '\r');
    await tick(50);
    expect(ui.lastFrame()).toContain('esc to cancel');
    await type(ui, '\u001b');
    await tick(80);
    expect(ui.frames.join('\n')).toContain('cancelled');
    expect(ui.lastFrame()).not.toContain('esc to cancel');
    ui.unmount();
  });

  it('runs slash commands', async () => {
    const { backend, requests } = fakeBackend(async function* () {
      yield chunk('x');
    });
    const ui = mount(backend);
    await tick();
    await type(ui, '/he');
    expect(ui.lastFrame()).toContain('/help');
    await type(ui, '\t');
    await type(ui, '\r');
    await tick(50);
    expect(ui.frames.join('\n')).toContain('Ctrl+C twice');

    await type(ui, '/model claude-sonnet-5-5');
    await type(ui, '\r');
    await tick(50);
    expect(ui.lastFrame()).toContain('claude-sonnet-5-5 · ');

    await type(ui, '/route');
    await type(ui, '\r');
    await tick(50);
    expect(ui.frames.join('\n')).toContain('1. anthropic/claude-sonnet-5-5');

    await type(ui, '/bogus');
    await type(ui, '\r');
    await tick(50);
    expect(ui.frames.join('\n')).toContain('Unknown command /bogus');
    expect(requests).toHaveLength(0);
    ui.unmount();
  });

  it('asks for a second Ctrl+C before exiting', async () => {
    const { backend } = fakeBackend(async function* () {});
    const ui = mount(backend);
    await tick();
    await type(ui, '\u0003');
    expect(ui.lastFrame()).toContain('Press Ctrl+C again to exit');
    ui.unmount();
  });
});
