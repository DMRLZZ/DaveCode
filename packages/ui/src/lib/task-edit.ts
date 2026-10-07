import type { TaskCreate, TaskNode, TaskPatch, TaskStatus } from './types';

/**
 * Pure logic behind the task editor: ids, transitions, dependency choices, cycle detection and
 * the draft <-> request conversions. Mirrors the rules enforced by the gateway (core's
 * `graph.ts`), so the UI can prevent mistakes before the server has to refuse them.
 */

/** Same pattern as core's `taskIdSchema`: lowercase kebab/snake segments, dots allowed inside. */
export const TASK_ID_PATTERN = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;

export function validateTaskId(id: string, tasks: readonly TaskNode[]): string | null {
  if (!id) return 'Give the task an id.';
  if (!TASK_ID_PATTERN.test(id)) {
    return 'Use lowercase letters, digits and - _ . (for example build-api).';
  }
  if (tasks.some((t) => t.id === id)) return `A task with the id "${id}" already exists.`;
  return null;
}

/** `Add the /health endpoint` -> `add-the-health-endpoint`. */
export function slugifyTaskId(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
}

/** `base`, or `base-2`, `base-3`… when the id is taken. Empty input yields `task`. */
export function uniqueTaskId(base: string, tasks: readonly TaskNode[]): string {
  const root = base || 'task';
  const taken = new Set(tasks.map((t) => t.id));
  if (!taken.has(root)) return root;
  for (let n = 2; ; n++) {
    const candidate = `${root}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Status transitions (mirror of core's canTransition)
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  PENDING: ['IN_PROGRESS'],
  IN_PROGRESS: ['SUCCESS', 'FAILED', 'PENDING'],
  FAILED: ['PENDING'],
  SUCCESS: ['PENDING'],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export interface StatusAction {
  to: TaskStatus;
  label: string;
  /** Visual weight: the one forward action is primary, the rest secondary. */
  variant: 'primary' | 'secondary';
}

/** Buttons offered for a task in `status`, derived from the allowed transitions. */
export function statusActions(status: TaskStatus): StatusAction[] {
  switch (status) {
    case 'PENDING':
      return [{ to: 'IN_PROGRESS', label: 'Start', variant: 'secondary' }];
    case 'IN_PROGRESS':
      return [
        { to: 'SUCCESS', label: 'Mark done', variant: 'primary' },
        { to: 'FAILED', label: 'Mark failed', variant: 'secondary' },
        { to: 'PENDING', label: 'Reopen', variant: 'secondary' },
      ];
    case 'FAILED':
    case 'SUCCESS':
      return [{ to: 'PENDING', label: 'Reopen', variant: 'secondary' }];
  }
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Ids of every task that depends on `id`, directly or transitively. */
export function descendantsOf(tasks: readonly TaskNode[], id: string): Set<string> {
  const out = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const task of tasks) {
      if (task.dependsOn.includes(current) && !out.has(task.id)) {
        out.add(task.id);
        queue.push(task.id);
      }
    }
  }
  return out;
}

/**
 * Tasks that can be chosen as dependencies of `selfId`: never the task itself, and (when
 * editing) never one of its descendants, which would close a cycle. Creation passes no id.
 */
export function dependencyCandidates(tasks: readonly TaskNode[], selfId?: string): TaskNode[] {
  if (selfId === undefined) return [...tasks];
  const blocked = descendantsOf(tasks, selfId);
  return tasks.filter((t) => t.id !== selfId && !blocked.has(t.id));
}

/**
 * The cycle `id -> dependsOn -> ... -> id` that giving `id` these dependencies would create
 * (first id repeated at the end), or `null`. `id` may be a task that does not exist yet.
 */
export function findCyclePath(
  tasks: readonly TaskNode[],
  id: string,
  dependsOn: readonly string[],
): string[] | null {
  const deps = new Map<string, readonly string[]>(tasks.map((t) => [t.id, t.dependsOn]));
  deps.set(id, dependsOn);
  const seen = new Set<string>();
  const walk = (current: string, path: string[]): string[] | null => {
    for (const next of deps.get(current) ?? []) {
      if (next === id) return [...path, id];
      if (seen.has(next)) continue;
      seen.add(next);
      const found = walk(next, [...path, next]);
      if (found) return found;
    }
    return null;
  };
  return walk(id, [id]);
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export interface TaskDraft {
  id: string;
  title: string;
  description: string;
  /** One criterion per line. */
  acceptance: string;
  priority: string;
  notes: string;
  dependsOn: string[];
}

export function emptyDraft(): TaskDraft {
  return {
    id: '',
    title: '',
    description: '',
    acceptance: '',
    priority: '',
    notes: '',
    dependsOn: [],
  };
}

export function draftFromTask(task: TaskNode): TaskDraft {
  return {
    id: task.id,
    title: task.title,
    description: task.description ?? '',
    acceptance: (task.acceptance ?? []).join('\n'),
    priority: task.priority === undefined ? '' : String(task.priority),
    notes: task.notes ?? '',
    dependsOn: [...task.dependsOn],
  };
}

export function parseAcceptance(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);
}

export function parsePriority(raw: string): { value?: number; error?: string } {
  const text = raw.trim();
  if (!text) return {};
  const value = Number(text);
  if (!Number.isFinite(value)) return { error: 'Priority must be a number.' };
  return { value };
}

export interface DraftErrors {
  id?: string;
  title?: string;
  priority?: string;
  dependsOn?: string;
}

/** Validates a draft against the current graph. `editing` is the id of the task being edited. */
export function validateDraft(
  draft: TaskDraft,
  tasks: readonly TaskNode[],
  editing?: string,
): DraftErrors {
  const errors: DraftErrors = {};
  if (editing === undefined) {
    const idError = validateTaskId(draft.id.trim(), tasks);
    if (idError) errors.id = idError;
  }
  if (!draft.title.trim()) errors.title = 'Give the task a title.';
  else if (draft.title.trim().length > 300) errors.title = 'Keep the title under 300 characters.';
  const priority = parsePriority(draft.priority);
  if (priority.error) errors.priority = priority.error;

  const id = editing ?? draft.id.trim();
  if (draft.dependsOn.includes(id)) {
    errors.dependsOn = 'A task cannot depend on itself.';
  } else {
    const unknown = draft.dependsOn.find((d) => !tasks.some((t) => t.id === d));
    if (unknown) errors.dependsOn = `Unknown task "${unknown}".`;
    else if (id) {
      const cycle = findCyclePath(tasks, id, draft.dependsOn);
      if (cycle) errors.dependsOn = `Would create a dependency cycle: ${cycle.join(' → ')}.`;
    }
  }
  return errors;
}

export function createBody(draft: TaskDraft): TaskCreate {
  const description = draft.description.trim();
  const acceptance = parseAcceptance(draft.acceptance);
  const { value: priority } = parsePriority(draft.priority);
  return {
    id: draft.id.trim(),
    title: draft.title.trim(),
    ...(description && { description }),
    ...(draft.dependsOn.length > 0 && { dependsOn: draft.dependsOn }),
    ...(priority !== undefined && { priority }),
    ...(acceptance.length > 0 && { acceptance }),
  };
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** Only the fields that changed; `null` clears an optional field. Empty when nothing changed. */
export function patchFrom(task: TaskNode, draft: TaskDraft): TaskPatch {
  const patch: TaskPatch = {};
  const title = draft.title.trim();
  if (title !== task.title) patch.title = title;

  const description = draft.description.trim();
  if (description !== (task.description ?? '')) patch.description = description || null;

  const notes = draft.notes.trim();
  if (notes !== (task.notes ?? '')) patch.notes = notes || null;

  const acceptance = parseAcceptance(draft.acceptance);
  if (!sameList(acceptance, task.acceptance ?? [])) {
    patch.acceptance = acceptance.length > 0 ? acceptance : null;
  }

  const { value: priority } = parsePriority(draft.priority);
  if (priority !== task.priority) patch.priority = priority ?? null;

  if (!sameList(draft.dependsOn, task.dependsOn)) patch.dependsOn = draft.dependsOn;
  return patch;
}

export function isEmptyPatch(patch: TaskPatch): boolean {
  return Object.keys(patch).length === 0;
}
