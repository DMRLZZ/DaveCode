import { describe, expect, it } from 'vitest';
import { configSchema } from '../config/schema';
import type { GoalTask } from '../types';
import {
  applySafetyGuard,
  normalizeTasks,
  outboundAction,
  type PlannedTask,
  plannerPrompt,
  planSchema,
  resolveRoles,
  reviewSchema,
  roleSystemPrompt,
  sanitizeTaskId,
} from './plan';

const roles = resolveRoles(configSchema.parse({}).goal);

const planned = (...tasks: Array<Partial<PlannedTask> & { id: string }>): PlannedTask[] =>
  tasks.map((t) => ({ title: `Task ${t.id}`, role: 'writer', dependsOn: [], ...t }));

const task = (overrides: Partial<GoalTask> & { id: string }): GoalTask => ({
  title: `Task ${overrides.id}`,
  role: 'writer',
  kind: 'artifact',
  status: 'PENDING',
  dependsOn: [],
  round: 1,
  attempts: 0,
  ...overrides,
});

describe('roles', () => {
  it('ships the five built-in roles and merges config overrides', () => {
    expect(roles.map((r) => r.id)).toEqual([
      'planner',
      'researcher',
      'implementer',
      'reviewer',
      'writer',
    ]);
    const custom = resolveRoles(
      configSchema.parse({
        goal: {
          roles: {
            marketer: { description: 'Growth and positioning', route: 'cheap' },
            writer: { instructions: 'Spanish only.' },
          },
        },
      }).goal,
    );
    expect(custom.find((r) => r.id === 'marketer')).toEqual({
      id: 'marketer',
      description: 'Growth and positioning',
      kind: 'artifact',
      route: 'cheap',
    });
    const writer = custom.find((r) => r.id === 'writer');
    expect(writer?.instructions).toBe('Spanish only.');
    expect(roleSystemPrompt(writer!)).toContain('Spanish only.');
  });

  it('rejects invalid role ids in config', () => {
    expect(() => configSchema.parse({ goal: { roles: { 'Bad Role': {} } } })).toThrow();
  });
});

describe('safety guard', () => {
  it('detects outbound actions', () => {
    expect(outboundAction('Email the first 20 leads')).toBeDefined();
    expect(outboundAction('Post the launch thread on X')).toBeDefined();
    expect(outboundAction('Buy the domain')).toBeDefined();
    expect(outboundAction('Write a positioning statement')).toBeUndefined();
  });

  it('turns outbound artifact tasks into drafts', () => {
    const guarded = applySafetyGuard(
      task({ id: 'a', title: 'Send the newsletter to subscribers' }),
    );
    expect(guarded.title).toBe('Draft: Send the newsletter to subscribers');
    expect(guarded.description).toMatch(/never performs outbound actions/);
    expect(guarded.kind).toBe('artifact');
  });

  it('only converts code tasks that operate something live', () => {
    const feature = task({
      id: 'b',
      kind: 'code',
      role: 'implementer',
      title: 'Add email validation to the signup form',
    });
    expect(applySafetyGuard(feature)).toBe(feature);
    const deploy = applySafetyGuard(
      task({ id: 'c', kind: 'code', role: 'implementer', title: 'Deploy the site to production' }),
    );
    expect(deploy).toMatchObject({
      kind: 'artifact',
      title: 'Draft: Deploy the site to production',
    });
  });
});

describe('normalizeTasks', () => {
  const base = { existing: [] as GoalTask[], roles, round: 1, room: 10, codeTasks: true };

  it('sanitizes ids, maps dependencies and falls back for unknown roles', () => {
    const out = normalizeTasks(
      planned(
        { id: 'Market Research!', role: 'researcher' },
        { id: 'site', role: 'dev', kind: 'code', dependsOn: ['Market Research!', 'ghost'] },
        { id: 'site', role: 'writer' },
      ),
      base,
    );
    expect(out.map((t) => t.id)).toEqual(['market-research', 'site', 'site-2']);
    expect(out[1]).toMatchObject({
      role: 'implementer',
      kind: 'code',
      dependsOn: ['market-research'],
    });
    expect(out[2]?.role).toBe('writer');
    expect(sanitizeTaskId('***')).toBe('task');
  });

  it('respects the task cap and code availability', () => {
    const out = normalizeTasks(planned({ id: 'a', role: 'implementer' }, { id: 'b' }), {
      ...base,
      room: 1,
      codeTasks: false,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'artifact' });
    expect(out[0]?.description).toMatch(/implementation plan/);
  });

  it('breaks dependency cycles among new tasks', () => {
    const out = normalizeTasks(
      planned({ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }),
      base,
    );
    const edges = out.flatMap((t) => t.dependsOn.map((d) => `${t.id}->${d}`));
    expect(edges).toHaveLength(1);
  });
});

describe('schemas and prompts', () => {
  it('validates planner and reviewer replies', () => {
    expect(planSchema.safeParse({ tasks: [] }).success).toBe(false);
    expect(
      planSchema.parse({ tasks: [{ id: 'a', title: 'A', role: 'writer' }] }).tasks[0]?.dependsOn,
    ).toEqual([]);
    expect(reviewSchema.parse({ done: true, summary: 'ok' })).toEqual({
      done: true,
      summary: 'ok',
      retry: [],
      tasks: [],
    });
  });

  it('tells the planner when code tasks are unavailable', () => {
    expect(plannerPrompt(roles, false)).toMatch(/NOT available/);
    expect(plannerPrompt(roles, true)).not.toMatch(/NOT available/);
  });
});
