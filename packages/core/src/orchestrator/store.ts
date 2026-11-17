/**
 * Pane orchestrator persistence: every run of one project in a single JSON file under the
 * DaveCode home, `<home>/orchestrator/<sha256(projectDir) prefix>/runs.json`. Outside the project
 * so the agents' worktrees and the user's tree never see it.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { atomicWriteFile } from '../brain/fs-util';
import {
  ORCHESTRATOR_ACCESS,
  ORCHESTRATOR_AGENTS,
  ORCHESTRATOR_LIMITS,
  type OrchestratorRun,
  type RunTranscript,
} from './contract';

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
  access: z.enum(ORCHESTRATOR_ACCESS).optional(),
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

// --- Transcripts ------------------------------------------------------------------------------

/** Run ids are generated hex; anything else never becomes part of a file name. */
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TRANSCRIPT_FILE = /^output-([A-Za-z0-9_-]{1,64})\.json$/;

const transcriptSchema = z.object({
  version: z.literal(1),
  streams: z.record(
    z.string(),
    z.object({
      from: z.number().int().min(0),
      chunks: z.array(
        z.object({ kind: z.enum(['text', 'tool', 'status', 'error']), text: z.string() }),
      ),
    }),
  ),
});

/**
 * What the agents of each run printed, one `output-<runId>.json` next to `runs.json`. Kept apart
 * from the runs so a state change does not rewrite every transcript.
 */
export class TranscriptStore {
  private readonly dir: string;
  private readonly queued = new Map<string, string>();
  private writing: Promise<void> | undefined;

  /** `dir` overrides the folder (the chat keeps its transcripts apart from the orchestrator's). */
  constructor(home: string, projectDir: string, dir?: string) {
    this.dir = dir ?? dirname(orchestratorRunsPath(home, projectDir));
  }

  private file(runId: string): string | undefined {
    return RUN_ID.test(runId) ? join(this.dir, `output-${runId}.json`) : undefined;
  }

  /** The stored transcript; a missing or corrupt file yields none. */
  load(runId: string): RunTranscript | undefined {
    const file = this.file(runId);
    if (!file) return undefined;
    try {
      const parsed = transcriptSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      const max = ORCHESTRATOR_LIMITS.transcriptMaxChunks;
      const streams: RunTranscript = {};
      for (const [taskId, stream] of Object.entries(parsed.streams)) {
        const extra = Math.max(0, stream.chunks.length - max);
        streams[taskId] = { from: stream.from + extra, chunks: stream.chunks.slice(extra) };
      }
      return streams;
    } catch {
      return undefined;
    }
  }

  /** Writes a snapshot in the background; a newer snapshot of the same run replaces a queued one. */
  save(runId: string, transcript: RunTranscript): Promise<void> {
    if (!this.file(runId)) return Promise.resolve();
    this.queued.set(runId, `${JSON.stringify({ version: 1, streams: transcript })}\n`);
    if (!this.writing) {
      this.writing = this.drain().finally(() => {
        this.writing = undefined;
      });
    }
    return this.writing;
  }

  async flush(): Promise<void> {
    while (this.writing) await this.writing;
  }

  /** Removes the transcripts of runs that are no longer kept. */
  prune(keep: ReadonlySet<string>): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const id = TRANSCRIPT_FILE.exec(name)?.[1];
      if (!id || keep.has(id) || this.queued.has(id)) continue;
      try {
        rmSync(join(this.dir, name), { force: true });
      } catch {
        // Best effort: a leftover transcript is small and harmless.
      }
    }
  }

  private async drain(): Promise<void> {
    for (;;) {
      const next = this.queued.entries().next();
      if (next.done) return;
      const [runId, content] = next.value;
      this.queued.delete(runId);
      const file = this.file(runId);
      if (!file) continue;
      try {
        await atomicWriteFile(file, content);
      } catch {
        // Disk full, permissions…: the transcript stays in memory for this session.
      }
    }
  }
}
