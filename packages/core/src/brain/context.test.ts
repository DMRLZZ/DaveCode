import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskNode } from '../types';
import {
  buildTaskContext,
  CONTEXT_TRUNCATION_MARKER,
  DAVECODE_SYSTEM_PROMPT,
  DEFAULT_CONTEXT_BUDGET_CHARS,
} from './context';
import { GlobalBrain } from './global';
import { ProjectBrain } from './project';

let tmp: string;
let global: GlobalBrain;
let project: ProjectBrain;

const task: TaskNode = {
  id: 'feature-x',
  title: 'Implement feature X',
  description: 'Build the thing.',
  status: 'PENDING',
  dependsOn: ['base', 'ghost'],
  acceptance: ['tests pass', 'docs updated'],
  notes: 'Tried approach A; it failed.',
};

const logEntries = Array.from(
  { length: 40 },
  (_, i) => `- 2030-01-01T00:00:${String(i).padStart(2, '0')}Z: event number ${i}`,
);

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'davecode-context-'));
  global = new GlobalBrain(join(tmp, 'home', 'brain'));
  project = await ProjectBrain.init(join(tmp, 'repo'), { name: 'Demo' });
  await global.write('prefs', 'GLOBAL-PREF '.repeat(100).trim());
  await project.writeState(
    `# State\n\n## Current focus\n\nFOCUS-MARKER\n\n## Activity log\n\n${logEntries.join('\n')}\n`,
  );
  await project.writeGraph({
    version: 1,
    tasks: [
      {
        id: 'base',
        title: 'Base work',
        status: 'SUCCESS',
        dependsOn: [],
        notes: 'merged cleanly\nsecond line',
      },
      { ...task, dependsOn: ['base'] },
    ],
  });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const build = (budgetChars?: number, withGlobal = true) =>
  buildTaskContext({
    ...(withGlobal ? { global } : {}),
    project,
    task: { ...task, dependsOn: ['base', 'ghost'] },
    ...(budgetChars === undefined ? {} : { budgetChars }),
  });

describe('buildTaskContext', () => {
  it('merges global brain, architecture, state and task in that order', async () => {
    const ctx = await build();
    const order = [
      '===== GLOBAL BRAIN',
      '===== PROJECT ARCHITECTURE',
      '===== PROJECT STATE',
      '===== CURRENT TASK',
    ].map((h) => ctx.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(ctx).toContain('## prefs');
    expect(ctx).toContain('Demo: architecture');
    expect(ctx).toContain('FOCUS-MARKER');
    expect(ctx).not.toContain(CONTEXT_TRUNCATION_MARKER);
    expect(ctx.length).toBeLessThanOrEqual(DEFAULT_CONTEXT_BUDGET_CHARS);
  });

  it('describes the task with acceptance criteria, notes and dependency summaries', async () => {
    const ctx = await build();
    const taskPart = ctx.slice(ctx.indexOf('===== CURRENT TASK'));
    expect(taskPart).toContain('id: feature-x');
    expect(taskPart).toContain('title: Implement feature X');
    expect(taskPart).toContain('Build the thing.');
    expect(taskPart).toContain('- tests pass');
    expect(taskPart).toContain('- docs updated');
    expect(taskPart).toContain('Tried approach A; it failed.');
    expect(taskPart).toContain('- base: Base work [SUCCESS] (merged cleanly)');
    expect(taskPart).toContain('- ghost: (not found in the task graph)');
  });

  it('works without a global brain', async () => {
    const ctx = await build(undefined, false);
    expect(ctx).toMatch(/GLOBAL BRAIN[^\n]*\n\(empty\)\n/);
  });

  it('truncates global notes first, leaving everything else intact', async () => {
    const full = await build();
    const ctx = await build(full.length - 300);
    expect(ctx.length).toBeLessThanOrEqual(full.length - 300);
    expect(ctx.match(/truncated to fit/g)).toHaveLength(1);
    const globalPart = ctx.slice(0, ctx.indexOf('===== PROJECT ARCHITECTURE'));
    expect(globalPart).toContain(CONTEXT_TRUNCATION_MARKER);
    expect(ctx.slice(ctx.indexOf('===== PROJECT ARCHITECTURE'))).toBe(
      full.slice(full.indexOf('===== PROJECT ARCHITECTURE')),
    );
  });

  it('omits global notes entirely before touching STATE.md', async () => {
    const full = await build();
    const withoutGlobal = await build(undefined, false);
    // The "(empty)" placeholder is 31 chars shorter than the omitted marker; +32 leaves room for it.
    const ctx = await build(withoutGlobal.length + 32);
    expect(ctx).toContain('[… omitted to fit the context budget]');
    expect(ctx).not.toContain('GLOBAL-PREF');
    expect(ctx).toContain('event number 0');
    expect(full.length).toBeGreaterThan(ctx.length);
  });

  it('then drops the oldest activity log entries, keeping the newest', async () => {
    const withoutGlobal = await build(undefined, false);
    const ctx = await build(withoutGlobal.length - 400);
    expect(ctx.length).toBeLessThanOrEqual(withoutGlobal.length - 400);
    expect(ctx).not.toContain('GLOBAL-PREF');
    expect(ctx).toContain('older entries truncated');
    expect(ctx).not.toContain('event number 0\n');
    expect(ctx).toContain('event number 39');
    expect(ctx).toContain('FOCUS-MARKER');
    expect(ctx).toContain('Demo: architecture');
  });

  it('then cuts the rest of STATE.md, and architecture only as a last resort', async () => {
    const full = await build();
    const taskStart = full.indexOf('===== CURRENT TASK');
    const minimal = await build(0);
    const floor = minimal.length;
    expect(minimal.slice(minimal.indexOf('===== CURRENT TASK'))).toBe(full.slice(taskStart));

    // Sweep budgets from generous to tight: whatever gets cut must follow the priority order.
    let sawStateCut = false;
    let sawArchitectureCut = false;
    for (let budget = full.length; budget >= floor; budget -= 25) {
      const ctx = await build(budget);
      expect(ctx.length).toBeLessThanOrEqual(Math.max(budget, floor));
      expect(ctx.slice(ctx.indexOf('===== CURRENT TASK'))).toBe(full.slice(taskStart));

      const globalPart = ctx.slice(0, ctx.indexOf('===== PROJECT ARCHITECTURE'));
      const archPart = ctx.slice(
        ctx.indexOf('===== PROJECT ARCHITECTURE'),
        ctx.indexOf('===== PROJECT STATE'),
      );
      const statePart = ctx.slice(
        ctx.indexOf('===== PROJECT STATE'),
        ctx.indexOf('===== CURRENT TASK'),
      );
      const globalCut = /truncated|omitted/.test(globalPart);
      const stateCut = /truncated|omitted/.test(statePart);
      const archCut = /truncated|omitted/.test(archPart);
      if (stateCut) {
        sawStateCut = true;
        expect(globalCut && !globalPart.includes('GLOBAL-PREF GLOBAL-PREF')).toBe(true);
      }
      if (archCut) {
        sawArchitectureCut = true;
        expect(stateCut).toBe(true);
        expect(statePart).not.toContain('event number');
        expect(globalPart).toContain('omitted');
      }
      if (!globalCut) {
        expect(stateCut || archCut).toBe(false);
      }
    }
    expect(sawStateCut).toBe(true);
    expect(sawArchitectureCut).toBe(true);
  });

  it('never truncates the task, even when the budget is tiny', async () => {
    const ctx = await build(10);
    expect(ctx).toContain('Build the thing.');
    expect(ctx).toContain('- docs updated');
    expect(ctx).toContain('Tried approach A; it failed.');
    expect(ctx).not.toContain('GLOBAL-PREF');
  });
});

describe('DAVECODE_SYSTEM_PROMPT', () => {
  it('is exported from the context module', () => {
    expect(DAVECODE_SYSTEM_PROMPT).toContain('DAVECODE_AUTONOMOUS_ENGINE_V1');
  });
});
