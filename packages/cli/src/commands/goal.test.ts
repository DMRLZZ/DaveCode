import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createEngine, type Engine, type Goal, ProjectBrain } from '@davecode/core';
import { FakeProvider } from '@davecode/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContext } from '../context';
import { CliError } from '../errors';
import { cli, type TempDir, tempDir, testEnv, testIO } from '../test-utils';
import { type GoalDeps, goalCommand, goalsCancel, goalsShow } from './goal';

let tmp: TempDir;
let home: string;
let repo: string;
let engine: Engine;
let fake: FakeProvider;

const PLAN = JSON.stringify({
  summary: 'one step',
  tasks: [{ id: 'copy', title: 'Write the landing copy', role: 'writer' }],
});

beforeEach(async () => {
  tmp = tempDir();
  home = join(tmp.path, 'home');
  repo = join(tmp.path, 'repo');
  mkdirSync(home);
  mkdirSync(repo);
  await ProjectBrain.init(repo, { name: 'demo' });
  fake = new FakeProvider('openai', ['m']);
  engine = createEngine({
    home,
    env: testEnv(home),
    databasePath: ':memory:',
    providers: new Map([['openai', fake]]),
    config: {
      routing: { routes: [{ name: 'auto', targets: [{ provider: 'openai', model: 'm' }] }] },
    },
  });
});
afterEach(() => {
  engine.close();
  tmp.cleanup();
});

const deps = (): GoalDeps => ({ engine, noGateway: true, interrupt: () => new Promise(() => {}) });

function context(json = false) {
  const io = testIO();
  return { io, ctx: createContext({ json }, io, { env: testEnv(home), cwd: repo }) };
}

describe('davecode goal', () => {
  it('runs a goal in-process, prints the log and the result', async () => {
    const account = engine.accounts.create({ provider: 'openai', label: 'a' });
    fake.script(
      account.id,
      { type: 'complete', content: PLAN },
      { type: 'complete', content: '# Landing copy\n\nShip faster.' },
      { type: 'complete', content: JSON.stringify({ done: true, summary: 'Copy is ready.' }) },
    );
    const { io, ctx } = context();
    const code = await goalCommand(ctx, ['Launch', 'the', 'landing'], {}, deps());
    expect(code).toBe(0);
    const out = io.stdout.text();
    expect(out).toContain('succeeded');
    expect(out).toContain('Write the landing copy');
    expect(out).toMatch(/\.davecode\/goals\/goal_[a-f0-9]+\/copy\.md/);
    expect(out).toContain('Copy is ready.');
    expect(io.stderr.text()).toMatch(/\[planner\] planning: Launch the landing/);
    expect(io.stderr.text()).toMatch(/code tasks disabled/);
  });

  it('prints the plan as JSON for a dry run and lists it afterwards', async () => {
    const account = engine.accounts.create({ provider: 'openai', label: 'a' });
    fake.script(account.id, { type: 'complete', content: PLAN });
    const { io, ctx } = context(true);
    expect(await goalCommand(ctx, ['Plan it'], { dryRun: true, maxRounds: 2 }, deps())).toBe(0);
    const { goal } = JSON.parse(io.stdout.text()) as { goal: Goal };
    expect(goal).toMatchObject({ status: 'planned', dryRun: true, limits: { maxRounds: 2 } });

    const listed = await cli(['goals'], { home, cwd: repo });
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(goal.id);
    expect(listed.stdout).toContain('planned');

    const shown = context();
    expect(await goalsShow(shown.ctx, goal.id, {})).toBe(0);
    expect(shown.io.stdout.text()).toContain('Write the landing copy');
  });

  it('exits 1 when no account can serve the goal', async () => {
    const { io, ctx } = context();
    expect(await goalCommand(ctx, ['Anything'], {}, deps())).toBe(1);
    expect(io.stdout.text()).toMatch(/failed/);
  });

  it('rejects an empty objective and unknown goals', async () => {
    const { ctx } = context();
    await expect(goalCommand(ctx, ['  '], {}, deps())).rejects.toBeInstanceOf(CliError);
    await expect(goalsShow(ctx, 'goal_000000', {})).rejects.toThrow(/Unknown goal/);
    await expect(goalsCancel(ctx, 'goal_000000', {}, deps())).rejects.toThrow(/Unknown goal/);
  });

  it('shows an empty list and help through the program', async () => {
    const res = await cli(['goals'], { home, cwd: repo });
    expect(res.stdout).toContain('No goals yet');
    const help = await cli(['goal', '--help'], { home, cwd: repo });
    expect(help.stdout).toContain('--dry-run');
    expect(help.stdout).toMatch(/never send emails/);
  });
});
