import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAVECODE_SYSTEM_PROMPT } from '../brain/system-prompt';
import type { CompletionResult, Router } from '../router/router';
import { fakeCompletion, fakeToolCall } from '../router/testing';
import type { ChatRequest, TaskNode, ToolCall, Usage } from '../types';
import {
  BuiltinExecutor,
  ExecutorAbortedError,
  ExecutorError,
  routeModel,
  TASK_INSTRUCTIONS,
} from './executor';

type Step = { content?: string; toolCalls?: ToolCall[]; usage?: Usage } | Error;

/** A router double that replays scripted assistant turns and records requests. */
function scriptedRouter(steps: Step[]) {
  const requests: ChatRequest[] = [];
  const router: Pick<Router, 'complete'> = {
    async complete(req): Promise<CompletionResult> {
      requests.push(structuredClone(req));
      const step = steps.shift() ?? { content: 'done' };
      if (step instanceof Error) throw step;
      return {
        completion: fakeCompletion(req.model, step.content ?? '', step.usage, step.toolCalls),
        meta: {
          requestId: 'r',
          accountId: 'a',
          provider: 'openai',
          model: req.model,
          failovers: 0,
        },
      };
    },
  };
  return { router, requests };
}

const task: TaskNode = { id: 't1', title: 'Add greeting', status: 'IN_PROGRESS', dependsOn: [] };
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'davecode-exec-'));
  writeFileSync(join(root, 'hello.txt'), 'hello world\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('routeModel', () => {
  it('maps route names to davecode/<route> and keeps model ids', () => {
    expect(routeModel('auto')).toBe('davecode/auto');
    expect(routeModel('openai/gpt-x')).toBe('openai/gpt-x');
  });
});

describe('BuiltinExecutor', () => {
  it('runs the tool loop until finish and edits files through the tools', async () => {
    const { router, requests } = scriptedRouter([
      { toolCalls: [fakeToolCall('read_file', { path: 'hello.txt' })] },
      {
        toolCalls: [
          fakeToolCall('edit_file', {
            path: 'hello.txt',
            old_string: 'world',
            new_string: 'DaveCode',
          }),
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      { toolCalls: [fakeToolCall('finish', { summary: 'Greets DaveCode' })] },
    ]);
    const executor = new BuiltinExecutor({ router, route: 'auto' });
    const logs: string[] = [];
    const session = executor.createSession({
      task,
      context: 'CONTEXT-MARKER',
      root,
      log: (_l, m) => logs.push(m),
    });
    const result = await session.run({ cycle: 0 });

    expect(result).toMatchObject({
      summary: 'Greets DaveCode',
      stopReason: 'finished',
      iterations: 3,
      changedFiles: ['hello.txt'],
    });
    expect(result.tokens).toBeGreaterThan(15);
    expect(readFileSync(join(root, 'hello.txt'), 'utf8')).toBe('hello DaveCode\n');

    const first = requests[0]!;
    expect(first.model).toBe('davecode/auto');
    expect(first.tools?.map((t) => t.function.name)).toContain('edit_file');
    expect(first.messages[0]).toEqual({ role: 'system', content: DAVECODE_SYSTEM_PROMPT });
    expect(first.messages[1]?.content).toContain(TASK_INSTRUCTIONS);
    expect(first.messages[1]?.content).toContain('CONTEXT-MARKER');
    // Tool results are fed back with the matching tool_call_id.
    const second = requests[1]!;
    const toolMsg = second.messages.at(-1)!;
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.content).toContain('hello world');
    expect(toolMsg.tool_call_id).toBe(second.messages.at(-2)?.tool_calls?.[0]?.id);
    expect(logs.some((l) => l.includes('edit_file hello.txt'))).toBe(true);
  });

  it('continues the same conversation on repair with the failure report', async () => {
    const { router, requests } = scriptedRouter([
      { toolCalls: [fakeToolCall('finish', { summary: 'first' })] },
      { toolCalls: [fakeToolCall('finish', { summary: 'fixed' })] },
    ]);
    const session = new BuiltinExecutor({ router, route: 'auto' }).createSession({
      task,
      context: 'ctx',
      root,
    });
    await session.run({ cycle: 0 });
    const repaired = await session.run({ cycle: 1, failureReport: 'test FAILED: expected 2' });
    expect(repaired.summary).toBe('fixed');
    const last = requests[1]!.messages;
    expect(last[1]?.content).toContain('ctx');
    expect(last.at(-1)?.role).toBe('user');
    expect(last.at(-1)?.content).toContain('REPAIR CYCLE 1');
    expect(last.at(-1)?.content).toContain('test FAILED: expected 2');
    expect(repaired.totalTokens).toBeGreaterThan(repaired.tokens);
  });

  it('nudges once, then stops when the model keeps answering without tools', async () => {
    const { router, requests } = scriptedRouter([
      { content: 'I think…' },
      { content: 'All done.' },
    ]);
    const session = new BuiltinExecutor({ router, route: 'auto' }).createSession({
      task,
      context: 'ctx',
      root,
    });
    const result = await session.run({ cycle: 0 });
    expect(result).toMatchObject({ stopReason: 'no_tool_calls', summary: 'All done.' });
    expect(requests[1]?.messages.at(-1)?.content).toMatch(/call the finish tool/);
  });

  it('caps iterations and tokens', async () => {
    const loop = () => ({ toolCalls: [fakeToolCall('list_dir', {})] });
    const a = scriptedRouter([loop(), loop(), loop(), loop()]);
    const capped = await new BuiltinExecutor({ router: a.router, route: 'auto', maxIterations: 2 })
      .createSession({ task, context: 'ctx', root })
      .run({ cycle: 0 });
    expect(capped).toMatchObject({ stopReason: 'max_iterations', iterations: 2 });

    const big = { prompt_tokens: 900, completion_tokens: 200, total_tokens: 1_100 };
    const b = scriptedRouter([{ ...loop(), usage: big }, loop()]);
    const budget = await new BuiltinExecutor({
      router: b.router,
      route: 'auto',
      maxTaskTokens: 1000,
    })
      .createSession({ task, context: 'ctx', root })
      .run({ cycle: 0 });
    expect(budget).toMatchObject({ stopReason: 'token_budget', iterations: 1 });
  });

  it('wraps upstream failures and honours abort signals', async () => {
    const failing = scriptedRouter([new Error('boom')]);
    await expect(
      new BuiltinExecutor({ router: failing.router, route: 'auto' })
        .createSession({ task, context: 'ctx', root })
        .run({ cycle: 0 }),
    ).rejects.toBeInstanceOf(ExecutorError);

    const hanging: Pick<Router, 'complete'> = {
      complete: (_req, opts) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };
    const controller = new AbortController();
    const pending = new BuiltinExecutor({ router: hanging, route: 'auto' })
      .createSession({ task, context: 'ctx', root })
      .run({ cycle: 0, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toBeInstanceOf(ExecutorAbortedError);
  });
});
