/**
 * Goal persistence: `<repo>/.davecode/goals/<goal-id>/goal.json` plus one markdown artifact per
 * task. Living under `.davecode/` keeps goal output out of the runner's dirty-tree check and out
 * of the project's own source tree.
 */
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { atomicWriteFile, isNodeError, readFileIfExists } from '../brain/fs-util';
import { taskStatusSchema } from '../brain/graph';
import { projectPaths } from '../paths';
import type { Goal } from '../types';

const GOAL_ID = /^goal_[a-z0-9]{6,32}$/;

const goalTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  description: z.string().optional(),
  role: z.string(),
  kind: z.enum(['code', 'artifact']),
  status: taskStatusSchema,
  dependsOn: z.array(z.string()),
  acceptance: z.array(z.string()).optional(),
  round: z.number().int().min(1),
  attempts: z.number().int().min(0),
  artifact: z.string().optional(),
  runnerTaskId: z.string().optional(),
  notes: z.string().optional(),
});

export const goalSchema = z.object({
  id: z.string().regex(GOAL_ID),
  objective: z.string().min(1),
  status: z.enum([
    'planning',
    'running',
    'reviewing',
    'planned',
    'succeeded',
    'failed',
    'cancelled',
    'budget_exhausted',
  ]),
  round: z.number().int().min(0),
  limits: z.object({
    maxRounds: z.number().int().min(1),
    maxTasks: z.number().int().min(1),
    maxTokens: z.number().int().min(1),
    tokensUsed: z.number().int().min(0),
  }),
  roles: z.array(
    z.object({ id: z.string(), description: z.string(), route: z.string().optional() }),
  ),
  tasks: z.array(goalTaskSchema),
  activeTaskId: z.string().optional(),
  summary: z.string().optional(),
  lastError: z.string().optional(),
  dryRun: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().optional(),
});

export function isGoalId(id: string): boolean {
  return GOAL_ID.test(id);
}

export class GoalStore {
  readonly dir: string;

  constructor(readonly root: string) {
    this.dir = join(projectPaths(root).dir, 'goals');
  }

  goalDir(id: string): string {
    if (!isGoalId(id)) throw new Error(`invalid goal id: ${id}`);
    return join(this.dir, id);
  }

  async save(goal: Goal): Promise<void> {
    await atomicWriteFile(
      join(this.goalDir(goal.id), 'goal.json'),
      `${JSON.stringify(goal, null, 2)}\n`,
    );
  }

  /** The goal, or `undefined` when unknown. Throws when `goal.json` is corrupt. */
  async load(id: string): Promise<Goal | undefined> {
    if (!isGoalId(id)) return undefined;
    const text = await readFileIfExists(join(this.goalDir(id), 'goal.json'));
    if (text === undefined) return undefined;
    return goalSchema.parse(JSON.parse(text)) as Goal;
  }

  /** Every readable goal, newest first. Corrupt entries are skipped. */
  async list(): Promise<Goal[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if (isNodeError(err, 'ENOENT')) return [];
      throw err;
    }
    const goals: Goal[] = [];
    for (const name of names.filter(isGoalId)) {
      try {
        const goal = await this.load(name);
        if (goal) goals.push(goal);
      } catch {
        // unreadable goal.json: not listed
      }
    }
    return goals.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Writes a task's markdown artifact and returns its repository-relative path (`/`-separated). */
  async writeArtifact(goalId: string, taskId: string, markdown: string): Promise<string> {
    const path = join(this.goalDir(goalId), `${taskId}.md`);
    await atomicWriteFile(path, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
    return relative(this.root, path).split('\\').join('/');
  }

  async readArtifact(goalId: string, taskId: string): Promise<string | undefined> {
    return readFileIfExists(join(this.goalDir(goalId), `${taskId}.md`));
  }
}
