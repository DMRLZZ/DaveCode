import { describe, expect, it } from 'vitest';
import {
  buildPlanPrompt,
  buildRepairPrompt,
  buildTaskPrompt,
  findCycle,
  parsePlan,
  pickPlanner,
} from './plan';

const reply = (tasks: unknown[]) => JSON.stringify({ tasks });
const task = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  agent: 'claude',
  prompt: `Do ${title}`,
  dependsOn: [],
  ...extra,
});

describe('pickPlanner', () => {
  it('prefers claude, then codex, then agy', () => {
    expect(pickPlanner(['agy', 'codex', 'claude'])).toBe('claude');
    expect(pickPlanner(['agy', 'codex'])).toBe('codex');
    expect(pickPlanner(['agy'])).toBe('agy');
    expect(pickPlanner([])).toBeUndefined();
  });
});

describe('prompts', () => {
  it('plan prompt states the objective, agents, limit, parallel rules and reply shape', () => {
    const prompt = buildPlanPrompt({
      objective: 'Add dark mode',
      agents: ['claude', 'agy'],
      maxTasks: 4,
    });
    expect(prompt).toContain('Add dark mode');
    expect(prompt).toMatch(/- claude: Claude Code/);
    expect(prompt).toMatch(/- agy: Antigravity/);
    expect(prompt).not.toMatch(/- codex:/);
    expect(prompt).toContain('at most 4 tasks');
    expect(prompt).toMatch(/parallel/);
    expect(prompt).toMatch(/different files/);
    expect(prompt).toMatch(/dependsOn/);
    expect(prompt).toMatch(/self-contained/);
    expect(prompt).toContain('{"tasks":[{"title":string');
  });

  it('repair prompt quotes the previous reply and the error', () => {
    const prompt = buildRepairPrompt(
      { objective: 'X', agents: ['codex'], maxTasks: 2 },
      'sure, here you go',
      'the reply is not a valid JSON object',
    );
    expect(prompt).toContain('sure, here you go');
    expect(prompt).toContain('the reply is not a valid JSON object');
    expect(prompt).toContain('ONLY a JSON object');
  });

  it('task prompt states objective, scope, parallel work and the rules', () => {
    const tasks = [
      { id: 't1', title: 'API', agent: 'claude' as const },
      { id: 't2', title: 'UI', agent: 'agy' as const },
    ];
    const prompt = buildTaskPrompt({
      objective: 'Ship search',
      task: {
        id: 't2',
        title: 'UI',
        agent: 'agy',
        prompt: 'Build the search box.',
        dependsOn: ['t1'],
      },
      tasks,
    });
    expect(prompt).toContain('Ship search');
    expect(prompt).toContain('Your task: UI');
    expect(prompt).toContain('Build the search box.');
    expect(prompt).toMatch(/already in your copy[\s\S]*- API/);
    expect(prompt).toMatch(/in parallel[\s\S]*- API \(claude\)/);
    expect(prompt).toMatch(/Do not commit, push/);
    expect(prompt).toContain('.davecode/');
    expect(prompt).toMatch(/short summary/);
    expect(prompt).not.toMatch(/cut off/);
  });

  it('tells each agent how to verify its work for the access it has', () => {
    const tasks = [{ id: 't1', title: 'API', agent: 'claude' as const }];
    const base = { id: 't1', title: 'API', prompt: 'Build it.', dependsOn: [] };
    const prompt = (agent: 'claude' | 'codex', access?: 'edit' | 'full') =>
      buildTaskPrompt({ objective: 'X', task: { ...base, agent }, tasks, access });
    // Headless Claude Code is refused every command in `edit`, and says so up front.
    expect(prompt('claude')).toMatch(/cannot run shell commands/);
    expect(prompt('claude', 'edit')).toMatch(/do not try/);
    expect(prompt('codex')).not.toMatch(/cannot run shell commands/);
    expect(prompt('codex')).toMatch(/If you can run the tests/);
    expect(prompt('claude', 'full')).toMatch(/run the tests or the build/);
    expect(prompt('claude', 'full')).not.toMatch(/cannot run shell commands/);
  });

  it('tells a second attempt that the first one left files behind', () => {
    const prompt = buildTaskPrompt({
      objective: 'X',
      task: { id: 't1', title: 'API', agent: 'agy', prompt: 'Build it.', dependsOn: [] },
      tasks: [{ id: 't1', title: 'API', agent: 'agy' }],
      retry: true,
    });
    expect(prompt).toMatch(/first attempt at this task was cut off/);
  });
});

describe('parsePlan', () => {
  const options = { agents: ['claude', 'codex'] as const, maxTasks: 5 };

  it('normalizes ids, agents and dependencies', () => {
    const result = parsePlan(
      `Here is the plan:\n\`\`\`json\n${reply([
        task('A'),
        task('B', { agent: 'agy', dependsOn: [1, 2, 9, 0] }),
        task('C', { agent: 'gpt', dependsOn: ['t1', '2', 'x'] }),
        task('D', { agent: 'CODEX', dependsOn: null }),
      ])}\n\`\`\``,
      { agents: [...options.agents], maxTasks: 5 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tasks.map((t) => [t.id, t.agent, t.dependsOn, t.status])).toEqual([
      ['t1', 'claude', [], 'pending'],
      ['t2', 'claude', ['t1'], 'pending'],
      ['t3', 'codex', ['t1', 't2'], 'pending'],
      ['t4', 'codex', [], 'pending'],
    ]);
    expect(result.tasks[0]?.prompt).toBe('Do A');
  });

  it('caps the number of tasks and drops dependencies on removed tasks', () => {
    const result = parsePlan(
      reply([task('A'), task('B', { dependsOn: [3] }), task('C'), task('D')]),
      { agents: ['claude'], maxTasks: 2 },
    );
    expect(result.ok && result.tasks.map((t) => [t.id, t.dependsOn])).toEqual([
      ['t1', []],
      ['t2', []],
    ]);
  });

  it('rejects text without JSON, zero tasks and a wrong shape', () => {
    expect(parsePlan('I could not plan this.', { agents: ['claude'], maxTasks: 3 })).toEqual({
      ok: false,
      error: expect.stringMatching(/not a valid JSON object/),
    });
    expect(parsePlan('{"tasks":[]}', { agents: ['claude'], maxTasks: 3 })).toEqual({
      ok: false,
      error: expect.stringMatching(/no tasks/),
    });
    expect(parsePlan('{"tasks":[{"title":"A"}]}', { agents: ['claude'], maxTasks: 3 })).toEqual({
      ok: false,
      error: expect.stringMatching(/prompt/),
    });
  });

  it('rejects dependency cycles', () => {
    const result = parsePlan(
      reply([
        task('A', { dependsOn: [3] }),
        task('B', { dependsOn: [1] }),
        task('C', { dependsOn: [2] }),
      ]),
      { agents: ['claude'], maxTasks: 5 },
    );
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/cycle \(t1 -> t3 -> t2 -> t1\)/),
    });
  });

  it('findCycle returns undefined for a DAG', () => {
    expect(
      findCycle([
        { id: 't1', dependsOn: [] },
        { id: 't2', dependsOn: ['t1'] },
        { id: 't3', dependsOn: ['t1', 't2'] },
      ]),
    ).toBeUndefined();
  });
});
