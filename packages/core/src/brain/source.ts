import { basename, resolve } from 'node:path';
import type { TaskGraph } from '../types';
import { readFileIfExists } from './fs-util';
import { parseTaskGraph } from './graph';
import type { ProjectBrain } from './project';

/**
 * Read-only adapter from a {@link ProjectBrain} to the gateway's `BrainSource` shape
 * (`project()`, `graph()`, `state()`, `architecture()`), matched structurally so core never
 * imports the server. Missing brain files read as empty instead of failing the request; an
 * invalid task graph still throws `TaskGraphError`.
 */
export class ProjectBrainSource {
  readonly name: string;

  constructor(
    private readonly brain: Pick<ProjectBrain, 'root' | 'paths'>,
    name?: string,
  ) {
    this.name = name ?? basename(resolve(brain.root));
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
