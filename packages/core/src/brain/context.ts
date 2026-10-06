import type { TaskGraph, TaskNode } from '../types';
import type { GlobalBrain } from './global';
import { getSection, upsertSection } from './markdown';
import type { ProjectBrain } from './project';

export { DAVECODE_SYSTEM_PROMPT } from './system-prompt';

/** Default prompt budget in characters (roughly 15k tokens). */
export const DEFAULT_CONTEXT_BUDGET_CHARS = 60_000;

/** Appended wherever content was cut so the model (and humans) know the context is partial. */
export const CONTEXT_TRUNCATION_MARKER = '[… truncated to fit the context budget]';
const OMITTED_MARKER = '[… omitted to fit the context budget]';
const LOG_MARKER = '_[… older entries truncated to fit the context budget]_';

export interface TaskContextInput {
  /** Global brain; omit to build a project-only context. */
  global?: Pick<GlobalBrain, 'compose'>;
  project: Pick<ProjectBrain, 'readState' | 'readArchitecture' | 'readGraph'>;
  task: TaskNode;
  /** Maximum prompt size in characters. Defaults to {@link DEFAULT_CONTEXT_BUDGET_CHARS}. */
  budgetChars?: number;
}

const heading = (title: string) => `===== ${title} =====`;
const EMPTY = '(empty)';

function describeTask(task: TaskNode, graph: TaskGraph | undefined): string {
  const lines = [`id: ${task.id}`, `title: ${task.title}`, `status: ${task.status}`];
  if (task.attempts) lines.push(`attempts so far: ${task.attempts}`);
  if (task.branch) lines.push(`branch: ${task.branch}`);
  if (task.description) lines.push('', 'Description:', task.description.trim());
  if (task.acceptance?.length) {
    lines.push('', 'Acceptance criteria:', ...task.acceptance.map((c) => `- ${c}`));
  }
  if (task.notes) lines.push('', 'Notes from previous attempts:', task.notes.trim());
  if (task.dependsOn.length > 0) {
    lines.push('', 'Dependencies:');
    const byId = new Map(graph?.tasks.map((t) => [t.id, t]));
    for (const id of task.dependsOn) {
      const dep = byId.get(id);
      if (!dep) {
        lines.push(`- ${id}: (not found in the task graph)`);
        continue;
      }
      const note = dep.notes?.trim().split('\n')[0]?.slice(0, 200);
      lines.push(`- ${dep.id}: ${dep.title} [${dep.status}]${note ? ` (${note})` : ''}`);
    }
  }
  return lines.join('\n');
}

/** Cuts `text` by at least `excess` characters from the end, leaving a marker. */
function cutEnd(text: string, excess: number, omittedLabel = OMITTED_MARKER): string {
  const keep = text.length - excess - CONTEXT_TRUNCATION_MARKER.length - 1;
  if (keep <= 0) return omittedLabel;
  return `${text.slice(0, keep).trimEnd()}\n${CONTEXT_TRUNCATION_MARKER}`;
}

/** Drops the oldest Activity log bullets of STATE.md (at least `excess` characters). */
function trimActivityLog(state: string, excess: number): string {
  const body = getSection(state, 'Activity log');
  if (body === undefined) return state;
  const lines = body.split('\n').filter((l) => l !== LOG_MARKER);
  let removed = 0;
  let drop = 0;
  const needed = excess + LOG_MARKER.length + 1;
  while (drop < lines.length && removed < needed) {
    removed += (lines[drop] as string).length + 1;
    drop++;
  }
  const kept = lines.slice(drop);
  return upsertSection(state, 'Activity log', [LOG_MARKER, ...kept].join('\n'));
}

/**
 * Builds the single prompt injected into an autonomous task: GLOBAL BRAIN, ARCHITECTURE.md,
 * STATE.md and the task itself, in that order, each under a `===== TITLE =====` delimiter.
 *
 * When the result exceeds `budgetChars`, the least important material goes first: global notes,
 * then the STATE.md activity log (oldest entries first), then the rest of STATE.md, and only as a
 * last resort ARCHITECTURE.md. Every cut leaves an explicit truncation marker. The task section is
 * never truncated, so a budget smaller than the task itself yields an over-budget result.
 */
export async function buildTaskContext(input: TaskContextInput): Promise<string> {
  const budget = input.budgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS;
  const [globalNotes, architectureRaw, stateRaw, graph] = await Promise.all([
    input.global?.compose() ?? Promise.resolve(''),
    input.project.readArchitecture(),
    input.project.readState(),
    input.project.readGraph(),
  ]);

  let global = globalNotes.trim();
  let architecture = architectureRaw.trim();
  let state = stateRaw.trim();
  const taskText = describeTask(input.task, graph);

  const render = () =>
    [
      heading('GLOBAL BRAIN (user preferences and coding patterns)'),
      global || EMPTY,
      '',
      heading('PROJECT ARCHITECTURE (.davecode/ARCHITECTURE.md)'),
      architecture || EMPTY,
      '',
      heading('PROJECT STATE (.davecode/STATE.md)'),
      state || EMPTY,
      '',
      heading('CURRENT TASK'),
      taskText,
    ].join('\n');

  const excess = () => render().length - budget;

  if (global && excess() > 0) global = cutEnd(global, excess());
  if (state && excess() > 0) state = trimActivityLog(state, excess());
  if (state && excess() > 0) state = cutEnd(state, excess());
  if (architecture && excess() > 0) architecture = cutEnd(architecture, excess());

  return render();
}
