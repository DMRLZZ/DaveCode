import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceLock } from '../autonomous/workspace-lock';
import { configSchema } from '../config/schema';
import { type DaveEvent, EventBus } from '../events';
import { RouterError } from '../router/errors';
import type { CompletionResult, Router } from '../router/router';
import type { ChatRequest, Goal, GoalTask } from '../types';
import { type CodeTaskRunner, GoalOrchestrator, readyGoalTasks } from './orchestrator';
import { GoalError, GoalService } from './service';
import { GoalStore } from './store';

type Reply = string | ((req: ChatRequest, signal?: AbortSignal) => Promise<string> | string);

/** Router double: answers by agent (planner / reviewer / any other role), in order. */
class ScriptedRouter implements Pick<Router, 'complete'> {
  readonly calls: Array<{ agent: string; req: ChatRequest }> = [];
  constructor(
    private readonly script: Record<string, Reply[]>,
    private readonly tokens = 100,
  ) {}

  async complete(req: ChatRequest, opts: { signal?: AbortSignal } = {}): Promise<CompletionResult> {
    const system = String(req.messages[0]?.content ?? '');
    const agent = system.startsWith('You are the planner')
      ? 'planner'
      : system.startsWith('You are the reviewer')
        ? 'reviewer'
        : (/^You are the ([a-z0-9-]+)/.exec(system)?.[1] ?? 'unknown');
    this.calls.push({ agent, req });
    const queue = this.script[agent] ?? this.script.default ?? [];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === undefined) throw new Error(`no scripted reply for ${agent}`);
    const content = typeof next === 'string' ? next : await next(req, opts.signal);
    return {
      completion: {
        id: 'c',
        object: 'chat.completion',
        created: 0,
        model: req.model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: this.tokens / 2,
          completion_tokens: this.tokens / 2,
          total_tokens: this.tokens,
        },
      },
      meta: {} as CompletionResult['meta'],
    } as CompletionResult;
  }
}

const plan = (tasks: Array<Partial<GoalTask> & { id: string }>, summary = 'the plan') =>
  JSON.stringify({
    summary,
    tasks: tasks.map((t) => ({ title: `Do ${t.id}`, role: 'writer', ...t })),
  });
const review = (done: boolean, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ done, summary: done ? 'all done' : 'more work', ...extra });

let root: string;
let events: EventBus;
let seen: DaveEvent[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'davecode-goal-'));
  events = new EventBus();
  seen = [];
  events.subscribe((e) => seen.push(e));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup(
  router: Pick<Router, 'complete'>,
  goalConfig: Record<string, unknown> = {},
  extra: { codeRunner?: CodeTaskRunner; budget?: string } = {},
) {
  const store = new GoalStore(root);
  const orchestrator = new GoalOrchestrator({
    router,
    store,
    events,
    config: configSchema.parse({ goal: goalConfig }).goal,
    ...(extra.codeRunner ? { codeRunner: extra.codeRunner } : {}),
    ...(extra.budget ? { budgetContext: () => extra.budget ?? '' } : {}),
  });
  return { store, orchestrator };
}

async function runGoal(
  router: Pick<Router, 'complete'>,
  input: Partial<Parameters<GoalOrchestrator['create']>[0]> = {},
  goalConfig: Record<string, unknown> = {},
  extra: { codeRunner?: CodeTaskRunner; budget?: string } = {},
): Promise<{ goal: Goal; store: GoalStore }> {
  const { store, orchestrator } = setup(router, goalConfig, extra);
  const goal = orchestrator.create({ objective: 'Launch a landing page', ...input });
  await orchestrator.run(goal, new AbortController().signal);
  return { goal, store };
}

describe('GoalOrchestrator', () => {
  it('plans, writes artifacts in dependency order, applies the safety guard and succeeds', async () => {
    const router = new ScriptedRouter({
      planner: [
        plan([
          { id: 'research', role: 'researcher' },
          { id: 'outreach', title: 'Email the first leads', dependsOn: ['research'] },
        ]),
      ],
      researcher: ['# Research\n\nThe market is large.'],
      writer: ['```markdown\n# Draft email\n\nHello!\n```'],
      reviewer: [review(true)],
    });
    const { goal, store } = await runGoal(router, {}, {}, { budget: 'BUDGET: plenty left' });

    expect(goal.status).toBe('succeeded');
    expect(goal.summary).toBe('all done');
    expect(goal.tasks.map((t) => [t.id, t.status])).toEqual([
      ['research', 'SUCCESS'],
      ['outreach', 'SUCCESS'],
    ]);
    const outreach = goal.tasks[1];
    expect(outreach?.title).toBe('Draft: Email the first leads');
    expect(outreach?.artifact).toBe(`.davecode/goals/${goal.id}/outreach.md`);
    expect(readFileSync(join(root, outreach?.artifact ?? ''), 'utf8')).toBe(
      '# Draft email\n\nHello!\n',
    );

    const writerCall = router.calls.find((c) => c.agent === 'writer');
    const prompt = String(writerCall?.req.messages[1]?.content);
    expect(prompt).toContain('OUTPUT OF research');
    expect(prompt).toContain('The market is large.');
    expect(prompt).toContain('BUDGET: plenty left');
    expect(String(writerCall?.req.messages[0]?.content)).toMatch(/Never send emails/);

    expect(goal.limits.tokensUsed).toBe(400);
    expect(await store.load(goal.id)).toEqual(goal);
    expect(seen.some((e) => e.type === 'goal.updated' && e.goal.status === 'reviewing')).toBe(true);
    expect(seen.filter((e) => e.type === 'goal.log').length).toBeGreaterThan(3);
  });

  it('stops after planning in a dry run', async () => {
    const router = new ScriptedRouter({ planner: [plan([{ id: 'a' }])] });
    const { goal } = await runGoal(router, { dryRun: true });
    expect(goal).toMatchObject({ status: 'planned', dryRun: true, summary: 'the plan' });
    expect(goal.tasks[0]?.status).toBe('PENDING');
    expect(router.calls.map((c) => c.agent)).toEqual(['planner']);
  });

  it('re-plans with new tasks and retries until the reviewer is satisfied', async () => {
    const router = new ScriptedRouter({
      planner: [plan([{ id: 'a' }])],
      writer: ['# A', '# B'],
      reviewer: [
        review(false, { tasks: [{ id: 'b', title: 'B', role: 'writer', dependsOn: ['a'] }] }),
        review(true),
      ],
    });
    const { goal } = await runGoal(router);
    expect(goal.status).toBe('succeeded');
    expect(goal.round).toBe(2);
    expect(goal.tasks.map((t) => [t.id, t.round, t.status])).toEqual([
      ['a', 1, 'SUCCESS'],
      ['b', 2, 'SUCCESS'],
    ]);
  });

  it('fails after maxRounds without completion', async () => {
    const router = new ScriptedRouter({
      planner: [plan([{ id: 'a' }])],
      writer: ['# out'],
      reviewer: [review(false, { tasks: [{ id: 'more', title: 'More', role: 'writer' }] })],
    });
    const { goal } = await runGoal(router, { maxRounds: 2 });
    expect(goal.status).toBe('failed');
    expect(goal.round).toBe(2);
    expect(goal.lastError).toMatch(/2 round/);
  });

  it('ends with budget_exhausted when the token cap is reached', async () => {
    const router = new ScriptedRouter(
      { planner: [plan([{ id: 'a' }, { id: 'b' }])], writer: ['# out'], reviewer: [review(true)] },
      6_000,
    );
    const { goal } = await runGoal(router, { maxTokens: 10_000 });
    expect(goal.status).toBe('budget_exhausted');
    expect(goal.tasks.map((t) => t.status)).toEqual(['SUCCESS', 'PENDING']);
    expect(goal.lastError).toMatch(/token budget/);
  });

  it('treats an exhausted router as budget_exhausted', async () => {
    const router = new ScriptedRouter({
      planner: [plan([{ id: 'a' }])],
      writer: [
        () => {
          throw new RouterError('no_capacity', 'every account is saturated', { requestId: 'r' });
        },
      ],
    });
    const { goal } = await runGoal(router);
    expect(goal.status).toBe('budget_exhausted');
    expect(goal.lastError).toMatch(/capacity/);
  });

  it('recovers from one malformed planner reply and fails on two', async () => {
    const ok = await runGoal(
      new ScriptedRouter({
        planner: ['sorry, here is the plan', plan([{ id: 'a' }])],
        writer: ['# A'],
        reviewer: [review(true)],
      }),
    );
    expect(ok.goal.status).toBe('succeeded');

    const bad = await runGoal(new ScriptedRouter({ planner: ['nope'] }));
    expect(bad.goal.status).toBe('failed');
    expect(bad.goal.lastError).toMatch(/planner did not return valid JSON/);
  });

  it('retries failed tasks up to goal.maxTaskAttempts', async () => {
    let attempts = 0;
    const router = new ScriptedRouter({
      planner: [plan([{ id: 'a' }])],
      writer: [
        () => {
          attempts++;
          throw new Error('upstream exploded');
        },
      ],
      reviewer: [review(false)],
    });
    const { goal } = await runGoal(router, {}, { maxTaskAttempts: 3 });
    expect(attempts).toBe(3);
    expect(goal.tasks[0]).toMatchObject({
      status: 'FAILED',
      attempts: 3,
      notes: 'upstream exploded',
    });
    expect(goal.status).toBe('failed');
    expect(goal.lastError).toMatch(/no further work/);
  });

  it('hands code tasks to the code runner and counts its tokens', async () => {
    const seenTasks: Array<{ id: string; maxTokens: number }> = [];
    const codeRunner: CodeTaskRunner = {
      available: async () => ({ ok: true }),
      run: async (task, opts) => {
        seenTasks.push({ id: task.id, maxTokens: opts.maxTokens });
        return {
          ok: true,
          summary: 'implemented',
          tokens: 5_000,
          runnerTaskId: `goal-x-${task.id}`,
        };
      },
    };
    const router = new ScriptedRouter({
      planner: [plan([{ id: 'site', role: 'implementer', kind: 'code' }])],
      reviewer: [review(true)],
    });
    const { goal } = await runGoal(router, {}, {}, { codeRunner });
    expect(goal.status).toBe('succeeded');
    expect(goal.tasks[0]).toMatchObject({
      kind: 'code',
      status: 'SUCCESS',
      runnerTaskId: 'goal-x-site',
      notes: 'implemented',
    });
    expect(seenTasks[0]?.maxTokens).toBe(goal.limits.maxTokens - 100);
    expect(goal.limits.tokensUsed).toBe(5_200);
  });

  it('turns code tasks into plans when code cannot run', async () => {
    const codeRunner: CodeTaskRunner = {
      available: async () => ({ ok: false, reason: 'dirty tree' }),
      run: async () => {
        throw new Error('must not run');
      },
    };
    const router = new ScriptedRouter({
      planner: [plan([{ id: 'site', role: 'implementer', kind: 'code' }])],
      implementer: ['# Implementation plan'],
      reviewer: [review(true)],
    });
    const { goal } = await runGoal(router, {}, {}, { codeRunner });
    expect(goal.tasks[0]).toMatchObject({ kind: 'artifact', status: 'SUCCESS' });
    expect(seen.some((e) => e.type === 'goal.log' && /dirty tree/.test(e.message))).toBe(true);
  });

  it('lists ready tasks only when every dependency succeeded', () => {
    const t = (id: string, status: GoalTask['status'], dependsOn: string[] = []): GoalTask => ({
      id,
      title: id,
      role: 'writer',
      kind: 'artifact',
      status,
      dependsOn,
      round: 1,
      attempts: 0,
    });
    const ready = readyGoalTasks({
      tasks: [
        t('a', 'SUCCESS'),
        t('b', 'FAILED'),
        t('c', 'PENDING', ['a']),
        t('d', 'PENDING', ['b']),
      ],
    });
    expect(ready.map((x) => x.id)).toEqual(['c']);
  });
});

describe('GoalService', () => {
  it('runs one goal at a time, cancels it and releases the workspace lock', async () => {
    let entered: () => void = () => undefined;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const router = new ScriptedRouter({
      planner: [plan([{ id: 'a' }])],
      writer: [
        (_req, signal) =>
          new Promise<string>((_resolve, reject) => {
            entered();
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      ],
    });
    const { store, orchestrator } = setup(router);
    const lock = new WorkspaceLock();
    const service = new GoalService({ orchestrator, store, lock });

    const goal = await service.start({ objective: 'Write things' });
    expect(service.activeGoalId).toBe(goal.id);
    await expect(service.start({ objective: 'Another' })).rejects.toMatchObject({ code: 'busy' });
    await started;
    expect(lock.holder).toBe('goal');
    expect((await service.list())[0]?.id).toBe(goal.id);

    const cancelled = await service.cancel(goal.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.tasks[0]?.status).toBe('PENDING');
    expect(lock.holder).toBeUndefined();
    expect(service.activeGoalId).toBeUndefined();
    expect((await service.get(goal.id))?.status).toBe('cancelled');
  });

  it('refuses to start while the runner holds the lock, except for dry runs', async () => {
    const router = new ScriptedRouter({ planner: [plan([{ id: 'a' }])] });
    const { store, orchestrator } = setup(router);
    const lock = new WorkspaceLock();
    lock.acquire('runner');
    const service = new GoalService({ orchestrator, store, lock });
    const err = await service.start({ objective: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoalError);
    expect((err as GoalError).message).toMatch(/runner is running/);
    await expect(service.start({ objective: '  ' })).rejects.toMatchObject({ code: 'invalid' });

    const dry = await service.start({ objective: 'plan it', dryRun: true });
    expect((await service.wait(dry.id))?.status).toBe('planned');
  });

  it('marks a goal left unfinished by an earlier process as cancelled', async () => {
    const { store, orchestrator } = setup(new ScriptedRouter({}));
    const stale = orchestrator.create({ objective: 'old' });
    stale.status = 'running';
    await store.save(stale);
    const service = new GoalService({ orchestrator, store });
    expect((await service.cancel(stale.id)).status).toBe('cancelled');
    await expect(service.cancel('goal_unknown1')).rejects.toMatchObject({ code: 'not_found' });
  });
});
