import { access, mkdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { EventBus } from '../events';
import { type ProjectPaths, projectPaths } from '../paths';
import type { TaskGraph, TaskNode, TaskStatus } from '../types';
import { atomicWriteFile, readFileIfExists } from './fs-util';
import {
  parseTaskGraph,
  setTaskStatus as setGraphTaskStatus,
  type TaskPatch,
  updateTask as updateGraphTask,
} from './graph';

// ---------------------------------------------------------------------------
// Project root discovery
// ---------------------------------------------------------------------------

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walks up from `startDir` to the first directory containing `.davecode/` or `.git`.
 * Returns `undefined` when the filesystem root is reached without a match.
 */
export async function findProjectRoot(startDir: string): Promise<string | undefined> {
  let dir = resolve(startDir);
  for (;;) {
    if ((await exists(join(dir, '.davecode'))) || (await exists(join(dir, '.git')))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const today = (now: Date) => now.toISOString().slice(0, 10);

export function stateTemplate(name: string, now = new Date()): string {
  return `# ${name}: project state

_Last updated: ${today(now)}_

## Current focus

Describe what is being worked on right now.

## Done

- Project brain initialised by DaveCode.

## Blockers

None.

## Activity log
`;
}

export function architectureTemplate(name: string): string {
  return `# ${name}: architecture (project brain)

Condensed context injected into every autonomous task. Keep it short and factual.

- **Stack:** languages, frameworks, package manager, test runner.
- **Layout:** the main directories and what lives in each.
- **Conventions:** naming, error handling, formatting, commit style.
- **Quality gates:** the commands that must exit 0 before a task counts as done.
`;
}

export function taskGraphTemplate(): TaskGraph {
  return { version: 1, tasks: [] };
}

export function serializeGraph(graph: TaskGraph): string {
  return `${JSON.stringify(graph, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// ProjectBrain
// ---------------------------------------------------------------------------

export interface ProjectBrainOptions {
  /** Receives a `task.updated` event whenever a task is changed through the brain. */
  events?: EventBus;
  /** Clock override (tests). */
  now?: () => Date;
}

export interface ProjectBrainInitOptions extends ProjectBrainOptions {
  /** Project name used in the templates (defaults to the directory name). */
  name?: string;
}

export interface ProjectBrainSnapshot {
  state: string;
  architecture: string;
  graph: TaskGraph;
}

/** Read/write access to `<repo>/.davecode/`: STATE.md, ARCHITECTURE.md and TASK_GRAPH.json. */
export class ProjectBrain {
  readonly paths: ProjectPaths;
  protected readonly events: EventBus | undefined;
  protected readonly now: () => Date;

  constructor(
    readonly root: string,
    opts: ProjectBrainOptions = {},
  ) {
    this.paths = projectPaths(root);
    this.events = opts.events;
    this.now = opts.now ?? (() => new Date());
  }

  /** Scaffolds any missing brain file from its template. Existing files are never overwritten. */
  static async init(root: string, opts: ProjectBrainInitOptions = {}): Promise<ProjectBrain> {
    const brain = new ProjectBrain(root, opts);
    const name = opts.name ?? basename(resolve(root));
    await mkdir(brain.paths.dir, { recursive: true });
    const files: Array<[string, string]> = [
      [brain.paths.state, stateTemplate(name, brain.now())],
      [brain.paths.architecture, architectureTemplate(name)],
      [brain.paths.taskGraph, serializeGraph(taskGraphTemplate())],
    ];
    for (const [path, content] of files) {
      if (!(await exists(path))) await atomicWriteFile(path, content);
    }
    return brain;
  }

  /** Finds the project root from `startDir` and opens its brain, or `undefined` if none. */
  static async find(
    startDir: string,
    opts: ProjectBrainOptions = {},
  ): Promise<ProjectBrain | undefined> {
    const root = await findProjectRoot(startDir);
    return root === undefined ? undefined : new ProjectBrain(root, opts);
  }

  /** True when all three brain files exist. */
  async isInitialised(): Promise<boolean> {
    const { state, architecture, taskGraph } = this.paths;
    return (await Promise.all([state, architecture, taskGraph].map(exists))).every(Boolean);
  }

  async load(): Promise<ProjectBrainSnapshot> {
    const [state, architecture, graph] = await Promise.all([
      this.readState(),
      this.readArchitecture(),
      this.readGraph(),
    ]);
    return { state, architecture, graph };
  }

  // -- STATE.md / ARCHITECTURE.md -------------------------------------------

  async readState(): Promise<string> {
    return this.readText(this.paths.state);
  }

  async writeState(content: string): Promise<void> {
    await atomicWriteFile(this.paths.state, content);
  }

  async readArchitecture(): Promise<string> {
    return this.readText(this.paths.architecture);
  }

  // -- TASK_GRAPH.json ------------------------------------------------------

  /** Reads and validates the task graph. Throws `TaskGraphError` when it is invalid. */
  async readGraph(): Promise<TaskGraph> {
    return parseTaskGraph(await this.readText(this.paths.taskGraph));
  }

  /** Validates then atomically writes the graph (2-space JSON, trailing newline). */
  async writeGraph(graph: TaskGraph): Promise<void> {
    await atomicWriteFile(this.paths.taskGraph, serializeGraph(parseTaskGraph(graph)));
  }

  /** Applies `patch` to a task, persists the graph and emits `task.updated`. */
  async updateTask(id: string, patch: TaskPatch): Promise<TaskNode> {
    return this.mutateGraph(id, (graph) => updateGraphTask(graph, id, patch, { now: this.now() }));
  }

  /** Moves a task to `status` (transition rules apply), persists and emits `task.updated`. */
  async setTaskStatus(
    id: string,
    status: TaskStatus,
    opts: { notes?: string } = {},
  ): Promise<TaskNode> {
    return this.mutateGraph(id, (graph) =>
      setGraphTaskStatus(graph, id, status, { ...opts, now: this.now() }),
    );
  }

  // -- internals ------------------------------------------------------------

  private async mutateGraph(
    id: string,
    change: (graph: TaskGraph) => TaskGraph,
  ): Promise<TaskNode> {
    const next = change(await this.readGraph());
    await this.writeGraph(next);
    const task = next.tasks.find((t) => t.id === id) as TaskNode;
    this.events?.emit({ type: 'task.updated', task });
    return task;
  }

  private async readText(path: string): Promise<string> {
    const content = await readFileIfExists(path);
    if (content === undefined) {
      throw new Error(`Missing project brain file: ${path} (run ProjectBrain.init first)`);
    }
    return content;
  }
}
