import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { AGENT_IDS, type AgentId } from './agents';

/** What a pane runs. The renderer picks a kind; it never supplies a command line. */
export const PANE_KINDS = ['shell', ...AGENT_IDS] as ['shell', ...AgentId[]];
export type PaneKind = 'shell' | AgentId;

/** Same rule as core's `WORKSPACE_ID_PATTERN`: isolated workspace ids, never a path. */
const WORKSPACE_ID = /^[a-z0-9]{4,24}$/;

export const openSchema = z.object({
  kind: z.enum(PANE_KINDS as [string, ...string[]]).transform((kind) => kind as PaneKind),
  /** Isolated workspace to open the pane in (created through `/api/changes`). */
  workspace: z.string().regex(WORKSPACE_ID).optional(),
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(300),
});

export const writeSchema = z.object({
  id: z.string().min(1).max(64),
  data: z.string().max(1_000_000),
});

export const resizeSchema = z.object({
  id: z.string().min(1).max(64),
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(300),
});

/** Drops what must not leak into a pane: Electron's switches and DaveCode's own runtime values. */
export function paneEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.startsWith('ELECTRON_') || key.startsWith('DAVECODE_DESKTOP_')) continue;
    clean[key] = value;
  }
  clean.TERM = 'xterm-256color';
  clean.COLORTERM = 'truecolor';
  clean.TERM_PROGRAM = 'DaveCode';
  return clean;
}

/**
 * The worktree of isolated workspace `id` for `project`. Mirrors core's `paneWorkspacePath`
 * (the main bundle does not carry core); a test keeps the two in step.
 */
export function paneWorkspaceDir(home: string, project: string, id: string): string | undefined {
  if (!WORKSPACE_ID.test(id)) return undefined;
  const key = createHash('sha256').update(resolve(project)).digest('hex').slice(0, 16);
  return join(home, 'panes', key, id);
}
