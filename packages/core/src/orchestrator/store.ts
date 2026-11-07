/**
 * Pane orchestrator persistence: every run of one project in a single JSON file under the
 * DaveCode home, `<home>/orchestrator/<sha256(projectDir) prefix>/runs.json`. Outside the project
 * so the agents' worktrees and the user's tree never see it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { atomicWriteFile } from '../brain/fs-util';
import { ORCHESTRATOR_AGENTS, type OrchestratorRun } from './contract';

/** Runs kept on disk (newest by `createdAt`). */
export const ORCHESTRATOR_RUNS_KEPT = 20;

const agentSchema = z.enum(ORCHESTRATOR_AGENTS);

const taskSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  agent: agentSchema,
  prompt: z.string(),
  dependsOn: z.array(z.string()),
  status: z.enum(['pending', 'running', 'done', 'failed', 'conflict', 'cancelled', 'skipped']),
  branch: z.string().optional(),
  summary: z.string().optional(),
  changedFiles: z.array(z.string()).optional(),
  error: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
});

export const orchestratorRunSchema = z.object({
  id: z.string().min(1),
  objective: z.string(),
  status: z.enum(['planning', 'running', 'done', 'failed', 'cancelled']),
  agents: z.array(agentSchema),
  planner: agentSchema.optional(),
  baseBranch: z.string().optional(),
  baseCommit: z.string().optional(),
  integrationBranch: z.string().optional(),
  tasks: z.array(taskSchema),
  summary: z.string().optional(),
  error: z.string().optional(),
  appliedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const fileSchema = z.object({
  version: z.literal(1),
  runs: z.array(z.unknown()),
});

/** `<home>/orchestrator/<first 16 hex of sha256(projectDir)>/runs.json`. */
export function orchestratorRunsPath(home: string, projectDir: string): string {
  let key = resolve(projectDir);
  if (process.platform === 'win32') key = key.toLowerCase();
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return join(home, 'orchestrator', hash, 'runs.json');
}

/** Newest first by `createdAt`; ties keep their order. */
function newestFirst(runs: readonly OrchestratorRun[]): OrchestratorRun[] {
  return [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export class OrchestratorStore {
  readonly path: string;
  private queued: string | undefined;
  private writing: Promise<void> | undefined;

  constructor(home: string, projectDir: string) {
    this.path = orchestratorRunsPath(home, projectDir);
  }

  /**
   * The stored runs, newest first. A missing or corrupt file yields no runs; a run that does not
   * validate is skipped.
   */
  load(): OrchestratorRun[] {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch {
      return [];
    }
    let file: z.infer<typeof fileSchema>;
    try {
      file = fileSchema.parse(JSON.parse(text));
    } catch {
      return [];
    }
    const runs: OrchestratorRun[] = [];
    for (const entry of file.runs) {
      const parsed = orchestratorRunSchema.safeParse(entry);
      if (parsed.success) runs.push(parsed.data as OrchestratorRun);
    }
    return newestFirst(runs).slice(0, ORCHESTRATOR_RUNS_KEPT);
  }

  /**
   * Snapshots `runs` now and writes them atomically in the background, keeping the newest
   * {@link ORCHESTRATOR_RUNS_KEPT}. Writes are serialized; a snapshot that is still queued is
   * replaced by the newer one. Resolves once that snapshot (or a newer one) is on disk; never
   * rejects (a failed write is retried by the next save).
   */
  save(runs: readonly OrchestratorRun[]): Promise<void> {
    const kept = newestFirst(runs).slice(0, ORCHESTRATOR_RUNS_KEPT);
    this.queued = `${JSON.stringify({ version: 1, runs: kept }, null, 2)}\n`;
    if (!this.writing) {
      this.writing = this.drain().finally(() => {
        this.writing = undefined;
      });
    }
    return this.writing;
  }

  /** Waits for every queued write. */
  async flush(): Promise<void> {
    while (this.writing) await this.writing;
  }

  private async drain(): Promise<void> {
    while (this.queued !== undefined) {
      const content = this.queued;
      this.queued = undefined;
      try {
        await atomicWriteFile(this.path, content);
      } catch {
        // Disk full, permissions…: keep the runs in memory; the next save tries again.
      }
    }
  }
}
