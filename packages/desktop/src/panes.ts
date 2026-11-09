import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { z } from 'zod';

/** What a pane runs. The renderer picks a kind; it never supplies a command line. */
export const PANE_KINDS = ['shell', 'claude', 'codex', 'agy', 'davecode'] as const;
export type PaneKind = (typeof PANE_KINDS)[number];

const AGENT_COMMANDS: Record<Exclude<PaneKind, 'shell'>, string> = {
  claude: 'claude',
  codex: 'codex',
  agy: 'agy',
  davecode: 'davecode',
};

/** Same rule as core's `WORKSPACE_ID_PATTERN`: isolated workspace ids, never a path. */
const WORKSPACE_ID = /^[a-z0-9]{4,24}$/;

export const openSchema = z.object({
  kind: z.enum(PANE_KINDS),
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

export interface ShellPlan {
  file: string;
  args: string[];
}

/**
 * Starts agents inside the user's own shell so PATH, profiles and `.cmd` shims resolve exactly as
 * they do in any other terminal. The shell stays open when the agent exits, so a missing CLI shows
 * its real error instead of closing the pane.
 */
export function shellPlan(kind: PaneKind, platform: NodeJS.Platform, shell: string): ShellPlan {
  const command = kind === 'shell' ? undefined : AGENT_COMMANDS[kind];
  if (platform === 'win32') {
    return {
      file: shell,
      args: command ? ['-NoLogo', '-NoExit', '-Command', command] : ['-NoLogo'],
    };
  }
  return {
    file: shell,
    args: command ? ['-ilc', `${command}; exec "${shell}" -il`] : ['-il'],
  };
}

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
