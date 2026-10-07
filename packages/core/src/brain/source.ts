import { basename, resolve } from 'node:path';
import type { TaskGraph, TaskNode } from '../types';
import { readFileIfExists } from './fs-util';
import { type ClearableTaskField, type NewTask, parseTaskGraph, type TaskPatch } from './graph';
import type { ProjectBrain } from './project';

/**
 * Adapter from a {@link ProjectBrain} to the gateway's `BrainSource` shape (`project()`,
 * `graph()`, `state()`, `architecture()` plus the task write methods when the brain has them),
 * matched structurally so core never imports the server. Missing brain files read as empty instead of failing the request; an
 * invalid task graph still throws `TaskGraphError`.
 */
export class ProjectBrainSource {
  readonly name: string;

  /** Write methods; present only when the wrapped brain can write. */
  createTask?: (input: NewTask) => Promise<TaskNode>;
  updateTask?: (
    id: string,
    patch: TaskPatch,
    opts?: { clear?: readonly ClearableTaskField[] },
  ) => Promise<TaskNode>;
  removeTask?: (id: string) => Promise<TaskNode>;

  constructor(
    private readonly brain: Pick<ProjectBrain, 'root' | 'paths'> &
      Partial<Pick<ProjectBrain, 'createTask' | 'updateTask' | 'removeTask'>>,
    name?: string,
  ) {
    this.name = name ?? basename(resolve(brain.root));
    if (brain.createTask && brain.updateTask && brain.removeTask) {
      const writable = brain as Pick<ProjectBrain, 'createTask' | 'updateTask' | 'removeTask'>;
      this.createTask = (input) => writable.createTask(input);
      this.updateTask = (id, patch, opts) => writable.updateTask(id, patch, opts);
      this.removeTask = (id) => writable.removeTask(id);
    }
  }

  project(): { root: string; name: string } {
    return { root: this.brain.root, name: this.name };
  }

  async graph(): Promise<TaskGraph> {
    const raw = await readFileIfExists(this.brain.paths.taskGraph);
    return raw === undefined ? { version: 1, tasks: [] } : parseTaskGraph(raw);
  }

  async state(): Promise<string> {
    return (await readFileIfExists(this.brain.paths.state)) ?? '';
  }

  async architecture(): Promise<string> {
    return (await readFileIfExists(this.brain.paths.architecture)) ?? '';
  }
}
