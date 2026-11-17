import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DaveEvent, EventBus } from '../events';
import type {
  AgentAvailability,
  AgentRunner,
  AgentRunRequest,
  AgentRunResult,
} from '../orchestrator/contract';
import { ChatError, type ChatService, type ChatSession } from './contract';
import { createChatService, INTERRUPTED, titleFrom } from './service';
import { chatDir } from './store';

interface Call {
  request: AgentRunRequest;
  resolve(result: AgentRunResult): void;
}

/** Every run waits until the test resolves it; `edit` writes a file first, like an agent. */
class FakeRunner implements AgentRunner {
  installed = ['claude', 'codex'];
  readonly calls: Call[] = [];
  private waiters: Array<(call: Call) => void> = [];

  async availability(): Promise<AgentAvailability[]> {
    return (['claude', 'codex', 'agy'] as const).map((agent) => ({
      agent,
      available: this.installed.includes(agent),
    }));
  }

  run(request: AgentRunRequest): Promise<AgentRunResult> {
    return new Promise((resolve, reject) => {
      if (request.signal.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      request.signal.addEventListener(
        'abort',
        () => reject(new DOMException('The operation was aborted.', 'AbortError')),
        { once: true },
      );
      const call = { request, resolve };
      this.calls.push(call);
      this.waiters.shift()?.(call);
    });
  }

  next(): Promise<Call> {
    const waiting = this.calls.find((c) => !(c as { taken?: boolean }).taken);
    if (waiting) {
      (waiting as { taken?: boolean }).taken = true;
      return Promise.resolve(waiting);
    }
    return new Promise((resolve) =>
      this.waiters.push((call) => {
        (call as { taken?: boolean }).taken = true;
        resolve(call);
      }),
    );
  }
}

let home: string;
let project: string;
let events: EventBus;
let runner: FakeRunner;
let services: ChatService[];
let clock: number;

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: project, encoding: 'utf8', windowsHide: true });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'davecode-chat-home-'));
  project = mkdtempSync(join(tmpdir(), 'davecode-chat-project-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(project, 'api.ts'), 'return fetch(url)\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  events = new EventBus(5000);
  runner = new FakeRunner();
  services = [];
  clock = Date.UTC(2026, 10, 17, 12, 0, 0);
});

afterEach(async () => {
  for (const service of services) await service.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

let ids = 0;
function makeService(): ChatService {
  const service = createChatService({
    projectDir: project,
    home,
    events,
    runner,
    now: () => {
      clock += 1000;
      return new Date(clock);
    },
    newId: () => `c${++ids}`,
  });
  services.push(service);
  return service;
}

/** Resolves once the chat matches `predicate`, checked now and after every event. */
function waitFor(
  service: ChatService,
  id: string,
  predicate: (s: ChatSession) => boolean,
): Promise<ChatSession> {
  return new Promise((resolve) => {
    const check = () => {
      const session = service.get(id);
      if (session && predicate(session)) {
        off();
        resolve(session);
      }
    };
    const off = events.subscribe(check);
    check();
  });
}

const idle = (s: ChatSession) => s.turns.length > 0 && s.turns.at(-1)?.status !== 'running';

function chatEvents(): Extract<DaveEvent, { type: 'chat.output' }>[] {
  return events
    .recent()
    .filter((e): e is Extract<DaveEvent, { type: 'chat.output' }> => e.type === 'chat.output');
}

describe('chats', () => {
  it('creates a chat only for an installed agent', async () => {
    const service = makeService();
    const chat = await service.create({ agent: 'claude' });
    expect(chat).toMatchObject({ agent: 'claude', title: 'New chat', turns: [] });
    await expect(service.create({ agent: 'agy' })).rejects.toBeInstanceOf(ChatError);
    await expect(service.create({ agent: 'gpt' as 'claude' })).rejects.toThrow();
  });

  it('runs a turn in the project, streams it and keeps what the agent changed', async () => {
    const service = makeService();
    const chat = await service.create({ agent: 'claude' });
    const started = await service.send(chat.id, { text: 'Add retry to fetchUser\nplease' });
    expect(started.title).toBe('Add retry to fetchUser');
    expect(started.turns).toMatchObject([{ id: 'm1', status: 'running', access: 'edit' }]);

    const call = await runner.next();
    expect(call.request).toMatchObject({
      agent: 'claude',
      cwd: project,
      mode: 'edit',
      access: 'edit',
      prompt: 'Add retry to fetchUser\nplease',
    });
    expect(call.request.resume).toBeUndefined();
    call.request.onOutput({ kind: 'tool', text: 'Edit api.ts' });
    writeFileSync(join(project, 'api.ts'), 'return withRetry(fetch, url)\n');
    call.resolve({ ok: true, text: 'Failed requests now retry.', session: 'claude-1', tokens: 9 });

    const done = await waitFor(service, chat.id, idle);
    expect(done.agentSession).toBe('claude-1');
    expect(done.turns[0]).toMatchObject({
      status: 'done',
      reply: 'Failed requests now retry.',
      tokens: 9,
      files: [{ path: 'api.ts', status: 'modified', additions: 1, deletions: 1 }],
    });
    expect(service.patch(chat.id, 'm1')).toContain('+return withRetry(fetch, url)');
    expect(service.transcript(chat.id)?.m1?.chunks).toEqual([
      { kind: 'tool', text: 'Edit api.ts' },
    ]);
    expect(chatEvents().map((e) => [e.turnId, e.seq])).toEqual([['m1', 0]]);
  });

  it('continues the agent conversation and passes the access of each message', async () => {
    const service = makeService();
    const chat = await service.create({ agent: 'codex' });
    await service.send(chat.id, { text: 'one' });
    (await runner.next()).resolve({ ok: true, text: 'first', session: 'thread-9' });
    await waitFor(service, chat.id, idle);

    await service.send(chat.id, { text: 'two', access: 'full' });
    const second = await runner.next();
    expect(second.request).toMatchObject({ resume: 'thread-9', access: 'full', prompt: 'two' });
    second.resolve({ ok: true, text: 'second' });
    const done = await waitFor(service, chat.id, (s) => s.turns.length === 2 && idle(s));
    expect(done.turns.map((t) => [t.id, t.reply])).toEqual([
      ['m1', 'first'],
      ['m2', 'second'],
    ]);
    // A turn that changed nothing has no files and no diff.
    expect(done.turns[1]?.files).toBeUndefined();
    expect(service.patch(chat.id, 'm2')).toBe('');
  });

  it('refuses a message while the agent is still answering', async () => {
    const service = makeService();
    const chat = await service.create({ agent: 'claude' });
    await service.send(chat.id, { text: 'one' });
    await expect(service.send(chat.id, { text: 'two' })).rejects.toMatchObject({ code: 'busy' });
    expect(() => service.remove(chat.id)).toThrow(ChatError);
    (await runner.next()).resolve({ ok: true, text: 'ok' });
    await waitFor(service, chat.id, idle);
  });

  it('reports a failed turn and a cancelled one', async () => {
    const service = makeService();
    const chat = await service.create({ agent: 'claude' });
    await service.send(chat.id, { text: 'one' });
    (await runner.next()).resolve({ ok: false, text: '', error: 'Claude Code is not signed in' });
    const failed = await waitFor(service, chat.id, idle);
    expect(failed.turns[0]).toMatchObject({
      status: 'failed',
      error: 'Claude Code is not signed in',
    });

    await service.send(chat.id, { text: 'two' });
    await runner.next();
    expect(service.cancel(chat.id)).toBe(true);
    const cancelled = await waitFor(service, chat.id, (s) => s.turns.length === 2 && idle(s));
    expect(cancelled.turns[1]?.status).toBe('cancelled');
    expect(service.cancel(chat.id)).toBe(false);
  });

  it('keeps chats across restarts and marks a turn cut off by one', async () => {
    const first = makeService();
    const chat = await first.create({ agent: 'claude' });
    await first.send(chat.id, { text: 'one' });
    const call = await runner.next();
    call.request.onOutput({ kind: 'text', text: 'Working' });
    // DaveCode closes while the agent works: a new service reads what was saved.
    await first.close();
    const restarted = makeService();
    const again = restarted.get(chat.id);
    expect(again?.title).toBe('one');
    expect(again?.turns[0]?.status).toBe('cancelled');
    expect(restarted.transcript(chat.id)?.m1?.chunks).toEqual([{ kind: 'text', text: 'Working' }]);
  });

  it('fails a turn that was still running in a file from a crash', async () => {
    const first = makeService();
    const chat = await first.create({ agent: 'claude' });
    await first.send(chat.id, { text: 'one' });
    // Flush the running snapshot to disk without closing (as a crash would leave it).
    await (first as unknown as { store: { flush(): Promise<void> } }).store.flush();
    const restarted = createChatService({ projectDir: project, home, events, runner });
    expect(restarted.get(chat.id)?.turns[0]).toMatchObject({
      status: 'failed',
      error: INTERRUPTED,
    });
    services.push(restarted);
  });

  it('renames and removes a chat, with its files', async () => {
    const service = makeService();
    const chat = await service.create({ agent: 'claude', title: 'Retry' });
    expect(service.rename(chat.id, '  Retries everywhere  ')?.title).toBe('Retries everywhere');
    expect(service.rename('nope', 'x')).toBeUndefined();
    expect(service.remove(chat.id)).toBe(true);
    expect(service.remove(chat.id)).toBe(false);
    expect(service.list()).toEqual([]);
    expect(chatDir(home, project)).toContain('chat');
  });
});

describe('titleFrom', () => {
  it('takes the first line, shortened', () => {
    expect(titleFrom('  Fix the login\nand the tests')).toBe('Fix the login');
    expect(titleFrom('x'.repeat(100))).toHaveLength(60);
    expect(titleFrom('   ')).toBe('New chat');
  });
});

describe('cancelling early', () => {
  it('never starts the agent when the chat is cancelled before it does', async () => {
    const service = makeService();
    const chat = await service.create({ agent: 'claude' });
    await service.send(chat.id, { text: 'one' });
    service.cancel(chat.id);
    const done = await waitFor(service, chat.id, idle);
    expect(done.turns[0]?.status).toBe('cancelled');
    // The next message is taken at once.
    await service.send(chat.id, { text: 'two' });
    (await runner.next()).resolve({ ok: true, text: 'ok' });
    await waitFor(service, chat.id, (s) => s.turns.length === 2 && idle(s));
  });
});
