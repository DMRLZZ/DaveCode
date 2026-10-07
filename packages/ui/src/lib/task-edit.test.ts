import { describe, expect, it } from 'vitest';
import {
  canTransition,
  createBody,
  dependencyCandidates,
  descendantsOf,
  draftFromTask,
  emptyDraft,
  findCyclePath,
  isEmptyPatch,
  parseAcceptance,
  parsePriority,
  patchFrom,
  slugifyTaskId,
  statusActions,
  uniqueTaskId,
  validateDraft,
  validateTaskId,
} from './task-edit';
import type { TaskNode, TaskStatus } from './types';

const node = (id: string, dependsOn: string[] = [], status: TaskStatus = 'PENDING'): TaskNode => ({
  id,
  title: `Task ${id}`,
  status,
  dependsOn,
});

// a <- b <- c (c depends on b, b on a), d independent
const tasks = [node('a'), node('b', ['a']), node('c', ['b']), node('d')];

describe('ids', () => {
  it('slugifies titles', () => {
    expect(slugifyTaskId('Add the /health endpoint')).toBe('add-the-health-endpoint');
    expect(slugifyTaskId('  Café – Münster!! ')).toBe('cafe-munster');
    expect(slugifyTaskId('???')).toBe('');
    expect(slugifyTaskId('x'.repeat(80))).toHaveLength(48);
  });

  it('makes ids unique', () => {
    expect(uniqueTaskId('e', tasks)).toBe('e');
    expect(uniqueTaskId('a', tasks)).toBe('a-2');
    expect(uniqueTaskId('a', [...tasks, node('a-2')])).toBe('a-3');
    expect(uniqueTaskId('', tasks)).toBe('task');
  });

  it('validates ids like the gateway', () => {
    expect(validateTaskId('release-0.1.0', tasks)).toBeNull();
    expect(validateTaskId('snake_case_ok', tasks)).toBeNull();
    expect(validateTaskId('', tasks)).toMatch(/id/);
    expect(validateTaskId('Bad Id', tasks)).toMatch(/lowercase/);
    expect(validateTaskId('-lead', tasks)).toMatch(/lowercase/);
    expect(validateTaskId('a', tasks)).toMatch(/already exists/);
  });
});

describe('status transitions', () => {
  it('mirrors the core transition table', () => {
    expect(canTransition('PENDING', 'IN_PROGRESS')).toBe(true);
    expect(canTransition('PENDING', 'SUCCESS')).toBe(false);
    expect(canTransition('IN_PROGRESS', 'SUCCESS')).toBe(true);
    expect(canTransition('IN_PROGRESS', 'FAILED')).toBe(true);
    expect(canTransition('FAILED', 'SUCCESS')).toBe(false);
    expect(canTransition('SUCCESS', 'PENDING')).toBe(true);
    expect(canTransition('SUCCESS', 'SUCCESS')).toBe(true);
  });

  it('offers only allowed actions, with the right labels', () => {
    const labels = (s: TaskStatus) => statusActions(s).map((a) => `${a.label}>${a.to}`);
    expect(labels('PENDING')).toEqual(['Start>IN_PROGRESS']);
    expect(labels('IN_PROGRESS')).toEqual([
      'Mark done>SUCCESS',
      'Mark failed>FAILED',
      'Reopen>PENDING',
    ]);
    expect(labels('FAILED')).toEqual(['Reopen>PENDING']);
    expect(labels('SUCCESS')).toEqual(['Reopen>PENDING']);
    for (const from of ['PENDING', 'IN_PROGRESS', 'FAILED', 'SUCCESS'] as const) {
      for (const action of statusActions(from)) expect(canTransition(from, action.to)).toBe(true);
    }
  });
});

describe('dependency choices', () => {
  it('finds transitive dependents', () => {
    expect([...descendantsOf(tasks, 'a')].sort()).toEqual(['b', 'c']);
    expect([...descendantsOf(tasks, 'd')]).toEqual([]);
  });

  it('never offers the task itself or anything that would close a cycle', () => {
    expect(dependencyCandidates(tasks, 'a').map((t) => t.id)).toEqual(['d']);
    expect(dependencyCandidates(tasks, 'b').map((t) => t.id)).toEqual(['a', 'd']);
    expect(dependencyCandidates(tasks, 'd').map((t) => t.id)).toEqual(['a', 'b', 'c']);
    // Creating: every existing task is a valid dependency.
    expect(dependencyCandidates(tasks).map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('reports the cycle path', () => {
    expect(findCyclePath(tasks, 'a', ['c'])).toEqual(['a', 'c', 'b', 'a']);
    expect(findCyclePath(tasks, 'a', ['d'])).toBeNull();
    expect(findCyclePath(tasks, 'new', ['c'])).toBeNull();
    expect(findCyclePath(tasks, 'a', ['a'])).toEqual(['a', 'a']);
  });
});

describe('drafts', () => {
  it('parses acceptance criteria one per line, dropping list markers', () => {
    expect(parseAcceptance('- one\n* two\n3. three\r\n\n  plain  ')).toEqual([
      'one',
      'two',
      'three',
      'plain',
    ]);
    expect(parseAcceptance('  \n')).toEqual([]);
  });

  it('parses priority', () => {
    expect(parsePriority('')).toEqual({});
    expect(parsePriority(' 5 ')).toEqual({ value: 5 });
    expect(parsePriority('-2.5')).toEqual({ value: -2.5 });
    expect(parsePriority('high').error).toBeTruthy();
  });

  it('validates a new task', () => {
    const ok = { ...emptyDraft(), id: 'new-task', title: 'New', dependsOn: ['a'] };
    expect(validateDraft(ok, tasks)).toEqual({});
    expect(validateDraft({ ...ok, id: 'a' }, tasks).id).toMatch(/already exists/);
    expect(validateDraft({ ...ok, title: '  ' }, tasks).title).toBeTruthy();
    expect(validateDraft({ ...ok, priority: 'x' }, tasks).priority).toBeTruthy();
    expect(validateDraft({ ...ok, dependsOn: ['new-task'] }, tasks).dependsOn).toMatch(/itself/);
    expect(validateDraft({ ...ok, dependsOn: ['ghost'] }, tasks).dependsOn).toMatch(/Unknown/);
  });

  it('validates an edit: id is fixed, cycles are caught', () => {
    const draft = { ...draftFromTask(tasks[0] as TaskNode), dependsOn: ['c'] };
    expect(validateDraft(draft, tasks, 'a').dependsOn).toContain('a → c → b → a');
    expect(validateDraft({ ...draft, dependsOn: ['d'] }, tasks, 'a')).toEqual({});
    expect(validateDraft({ ...draft, dependsOn: ['a'] }, tasks, 'a').dependsOn).toMatch(/itself/);
  });

  it('builds a create body without empty optional fields', () => {
    expect(createBody({ ...emptyDraft(), id: ' x ', title: ' X ' })).toEqual({
      id: 'x',
      title: 'X',
    });
    expect(
      createBody({
        id: 'x',
        title: 'X',
        description: ' why ',
        acceptance: '- a\n- b',
        priority: '3',
        notes: 'ignored on create',
        dependsOn: ['a'],
      }),
    ).toEqual({
      id: 'x',
      title: 'X',
      description: 'why',
      acceptance: ['a', 'b'],
      priority: 3,
      dependsOn: ['a'],
    });
  });

  it('builds a minimal patch and clears fields with null', () => {
    const task: TaskNode = {
      ...node('b', ['a']),
      description: 'old',
      priority: 2,
      acceptance: ['x'],
      notes: 'n',
    };
    expect(isEmptyPatch(patchFrom(task, draftFromTask(task)))).toBe(true);
    const draft = {
      ...draftFromTask(task),
      title: 'Renamed',
      description: '',
      priority: '',
      acceptance: '',
      notes: 'n2',
      dependsOn: [],
    };
    expect(patchFrom(task, draft)).toEqual({
      title: 'Renamed',
      description: null,
      priority: null,
      acceptance: null,
      notes: 'n2',
      dependsOn: [],
    });
    expect(patchFrom(task, { ...draftFromTask(task), priority: '0' })).toEqual({ priority: 0 });
  });
});
