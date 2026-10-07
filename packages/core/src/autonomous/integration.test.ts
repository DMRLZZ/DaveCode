/**
 * End to end: a temp git repo with a two-task brain, a real engine (router, quotas, usage) over
 * a scripted FakeProvider that edits files through the tool protocol, the real validator
 * running a node script that fails before the repair, and the real git merge flow.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectBrain, serializeGraph } from '../brain/project';
import { createEngine, type Engine } from '../engine';
import type { DaveEvent } from '../events';
import { FakeProvider, fakeToolCall } from '../router/testing';
import type { ProviderKind, TaskGraph } from '../types';
import { createRunner } from './create';
import { createTempRepo, git } from './test-helpers';

const CHECK = `const fs = require('node:fs');
const { greet } = require('./src/greet.cjs');
const got = greet('x');
if (got !== 'hello x') {
  console.error('greet("x") returned ' + JSON.stringify(got) + ', expected "hello x"');
  process.exit(1);
}
if (fs.existsSync('./src/farewell.cjs')) {
  const { farewell } = require('./src/farewell.cjs');
  if (farewell('x') !== 'bye x') {
    console.error('farewell("x") returned ' + JSON.stringify(farewell('x')));
    process.exit(1);
  }
}
console.log('all checks passed');
`;

const GRAPH: TaskGraph = {
  version: 1,
  tasks: [
    {
      id: 'greet',
      title: 'Add greet()',
      description: 'Create src/greet.cjs exporting greet(name) that returns "hello <name>".',
      status: 'PENDING',
      dependsOn: [],
      acceptance: ['greet("x") returns "hello x"'],
    },
    {
      id: 'farewell',
      title: 'Add farewell()',
      description: 'Create src/farewell.cjs exporting farewell(name) that returns "bye <name>".',
      status: 'PENDING',
      dependsOn: ['greet'],
    },
  ],
};

let repo: ReturnType<typeof createTempRepo>;
let home: string;
let engine: Engine;
let fake: FakeProvider;

beforeEach(() => {
  repo = createTempRepo({ 'check.cjs': CHECK, '.gitignore': '.davecode/.lock\n' });
  home = mkdtempSync(join(tmpdir(), 'davecode-home-'));
  fake = new FakeProvider('openai');
  engine = createEngine({
    home,
    env: {},
    databasePath: ':memory:',
    providers: new Map<ProviderKind, FakeProvider>([['openai', fake]]),
    config: {
      runner: {
        route: 'openai/gpt-test',
        validate: { test: 'node check.cjs' },
        idlePollMs: 100,
        commandTimeoutMs: 30_000,
      },
    },
  });
});

afterEach(() => {
  engine.close();
  repo.cleanup();
  rmSync(home, { recursive: true, force: true });
});

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 30_000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('autonomous runner (integration)', () => {
  it('implements two dependent tasks, repairs a failing test, merges and updates the brain', async () => {
    const brain = await ProjectBrain.init(repo.root, { events: engine.events, name: 'demo' });
    writeFileSync(brain.paths.taskGraph, serializeGraph(GRAPH));
    git(repo.root, 'add', '--all');
    git(repo.root, 'commit', '--quiet', '-m', 'chore: add project brain');

    const account = engine.accounts.create({ provider: 'openai', label: 'fake' });
    fake.script(
      account.id,
      // Task greet, first pass: a typo the test catches.
      {
        type: 'complete',
        toolCalls: [
          fakeToolCall('write_file', {
            path: 'src/greet.cjs',
            content: "exports.greet = (name) => 'helo ' + name;\n",
          }),
        ],
      },
      { type: 'complete', toolCalls: [fakeToolCall('finish', { summary: 'Add greet()' })] },
      // Repair cycle 1: fix the typo.
      {
        type: 'complete',
        toolCalls: [
          fakeToolCall('edit_file', {
            path: 'src/greet.cjs',
            old_string: "'helo '",
            new_string: "'hello '",
          }),
        ],
      },
      { type: 'complete', toolCalls: [fakeToolCall('finish', { summary: 'Fix greeting typo' })] },
      // Task farewell.
      {
        type: 'complete',
        toolCalls: [
          fakeToolCall('write_file', {
            path: 'src/farewell.cjs',
            content: "exports.farewell = (name) => 'bye ' + name;\n",
          }),
          fakeToolCall('finish', { summary: 'Add farewell()' }),
        ],
      },
    );

    const runner = createRunner(engine, { brain, global: false });
    const events: DaveEvent[] = [];
    engine.events.subscribe((e) => events.push(e));

    await runner.start();
    await waitFor(async () => {
      const graph = await brain.readGraph();
      return graph.tasks.every((t) => t.status === 'SUCCESS') && runner.status().state === 'idle';
    });
    await runner.stop();
    expect(runner.status().state).toBe('stopped');

    // Task graph and STATE.md, on disk and committed on main.
    const graph = await brain.readGraph();
    expect(graph.tasks.map((t) => [t.id, t.status, t.attempts])).toEqual([
      ['greet', 'SUCCESS', 1],
      ['farewell', 'SUCCESS', 1],
    ]);
    expect(graph.tasks[0]?.notes).toContain('Fix greeting typo');
    const committedGraph = JSON.parse(git(repo.root, 'show', 'main:.davecode/TASK_GRAPH.json'));
    expect(committedGraph.tasks.map((t: { status: string }) => t.status)).toEqual([
      'SUCCESS',
      'SUCCESS',
    ]);
    const state = readFileSync(brain.paths.state, 'utf8');
    expect(state).toContain('Started task `greet`');
    expect(state).toContain('Task `greet` SUCCESS after 1 repair cycle(s)');
    expect(state).toContain('Task `farewell` SUCCESS after 0 repair cycle(s)');
    expect(git(repo.root, 'status', '--porcelain')).toBe('');

    // The code landed on main through --no-ff merges; task branches are gone.
    expect(git(repo.root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(readFileSync(join(repo.root, 'src', 'greet.cjs'), 'utf8')).toContain("'hello '");
    expect(readFileSync(join(repo.root, 'src', 'farewell.cjs'), 'utf8')).toContain("'bye '");
    const log = git(repo.root, 'log', '--format=%s', 'main');
    expect(log).toContain('feat: Add greet()');
    expect(log).toContain('feat: Add farewell()');
    expect(log).toContain('Merge davecode/task-greet: Add greet()');
    expect(log).toContain('chore(davecode): mark task farewell as SUCCESS');
    expect(git(repo.root, 'branch', '--list', 'davecode/*')).toBe('');
    expect(git(repo.root, 'log', '-n', '1', '--format=%B', 'main^{/feat: Add greet}')).toContain(
      'DaveCode-Task: greet',
    );

    // The repair pass received the exact validator failure output.
    expect(fake.calls).toHaveLength(5);
    expect(fake.calls[0]?.model).toBe('gpt-test');
    const repairPrompt = fake.calls[2]?.messages.at(-1);
    expect(repairPrompt?.role).toBe('user');
    expect(repairPrompt?.content).toContain('REPAIR CYCLE 1');
    expect(repairPrompt?.content).toContain('greet("x") returned "helo x", expected "hello x"');
    // The dependent task's context shows its dependency as done.
    expect(fake.calls[4]?.messages[1]?.content).toContain('- greet: Add greet() [SUCCESS]');

    // Observability: status transitions, task updates and usage.
    const states = events
      .filter((e): e is Extract<DaveEvent, { type: 'runner.status' }> => e.type === 'runner.status')
      .map((e) => e.status.state);
    expect(states.slice(0, 9)).toEqual([
      'selecting',
      'preparing',
      'implementing',
      'validating',
      'repairing',
      'implementing',
      'validating',
      'merging',
      'selecting',
    ]);
    expect(events.some((e) => e.type === 'task.updated' && e.task.status === 'SUCCESS')).toBe(true);
    expect(
      events.some((e) => e.type === 'runner.log' && e.message.includes('repair cycle 1/3')),
    ).toBe(true);
    expect(engine.quota.usage(account).windows['24h'].requests).toBe(5);
  }, 60_000);
});
