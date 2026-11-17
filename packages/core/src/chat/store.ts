/**
 * Chat persistence, outside the project so the agents never see it:
 * `<home>/chat/<sha256(projectDir) prefix>/` holds `sessions.json`, one `output-<chat>.json`
 * transcript per chat and one `patch-<chat>-<turn>.diff` per turn that changed something.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { atomicWriteFile } from '../brain/fs-util';
import { ORCHESTRATOR_ACCESS } from '../orchestrator/contract';
import { CHAT_AGENTS, CHAT_LIMITS, type ChatSession } from './contract';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function chatDir(home: string, projectDir: string): string {
  let key = resolve(projectDir);
  if (process.platform === 'win32') key = key.toLowerCase();
  return join(home, 'chat', createHash('sha256').update(key).digest('hex').slice(0, 16));
}

const turnSchema = z.object({
  id: z.string().regex(ID),
  prompt: z.string(),
  status: z.enum(['running', 'done', 'failed', 'cancelled']),
  access: z.enum(ORCHESTRATOR_ACCESS),
  reply: z.string().optional(),
  error: z.string().optional(),
  files: z
    .array(
      z.object({
        path: z.string(),
        status: z.enum(['added', 'modified', 'deleted']),
        additions: z.number().int().min(0),
        deletions: z.number().int().min(0),
      }),
    )
    .optional(),
  patchTruncated: z.boolean().optional(),
  tokens: z.number().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
});

const sessionSchema = z.object({
  id: z.string().regex(ID),
  agent: z.enum(CHAT_AGENTS),
  title: z.string(),
  agentSession: z.string().optional(),
  turns: z.array(turnSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export class ChatStore {
  readonly dir: string;
  private queued: string | undefined;
  private writing: Promise<void> | undefined;

  constructor(home: string, projectDir: string) {
    this.dir = chatDir(home, projectDir);
  }

  /** The stored chats, newest first; a corrupt file or chat is skipped. */
  load(): ChatSession[] {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(this.dir, 'sessions.json'), 'utf8'));
    } catch {
      return [];
    }
    const list = (raw as { sessions?: unknown })?.sessions;
    if (!Array.isArray(list)) return [];
    const sessions: ChatSession[] = [];
    for (const entry of list) {
      const parsed = sessionSchema.safeParse(entry);
      if (parsed.success) sessions.push(parsed.data as ChatSession);
    }
    return sessions
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, CHAT_LIMITS.sessionsKept);
  }

  /** Writes a snapshot in the background; never rejects. */
  save(sessions: readonly ChatSession[]): Promise<void> {
    this.queued = `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`;
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

  private async drain(): Promise<void> {
    while (this.queued !== undefined) {
      const content = this.queued;
      this.queued = undefined;
      try {
        await atomicWriteFile(join(this.dir, 'sessions.json'), content);
      } catch {
        // Disk full, permissions…: the chats stay in memory and the next save tries again.
      }
    }
  }

  private patchFile(sessionId: string, turnId: string): string | undefined {
    return ID.test(sessionId) && ID.test(turnId)
      ? join(this.dir, `patch-${sessionId}-${turnId}.diff`)
      : undefined;
  }

  async savePatch(sessionId: string, turnId: string, patch: string): Promise<void> {
    const file = this.patchFile(sessionId, turnId);
    if (!file || !patch) return;
    try {
      await atomicWriteFile(file, patch);
    } catch {
      // The turn still lists its files; only the diff is missing.
    }
  }

  loadPatch(sessionId: string, turnId: string): string {
    const file = this.patchFile(sessionId, turnId);
    if (!file) return '';
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  }

  /** Removes the diffs (and transcripts) of chats and turns that are no longer kept. */
  prune(keep: ReadonlyMap<string, ReadonlySet<string>>): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const patch = /^patch-([A-Za-z0-9_-]+)-([A-Za-z0-9_-]+)\.diff$/.exec(name);
      const output = /^output-([A-Za-z0-9_-]+)\.json$/.exec(name);
      const stale = patch
        ? !keep.get(patch[1] as string)?.has(patch[2] as string)
        : output
          ? !keep.has(output[1] as string)
          : false;
      if (!stale) continue;
      try {
        rmSync(join(this.dir, name), { force: true });
      } catch {
        // A leftover file is harmless.
      }
    }
  }
}
