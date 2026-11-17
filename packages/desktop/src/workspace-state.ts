import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { PANE_KINDS } from './panes';

/**
 * What the workspace page asks the app to remember for a project: its sessions, where their
 * panes sit and two preferences. The page runs on a different local port every launch, so its
 * own storage starts empty each time; this file is what survives. It holds names and layout
 * only, never anything typed into a terminal.
 */

const MAX_SESSIONS = 64;
const MAX_DEPTH = 12;
/** Largest state the app writes; a real one is a few hundred bytes. */
export const WORKSPACE_STATE_MAX_BYTES = 64_000;

const key = z.number().int().min(1).max(1_000_000);

const sessionSchema = z.object({
  key,
  kind: z.enum(PANE_KINDS),
  name: z.string().min(1).max(40),
  /** Same rule as `openSchema`: an isolated workspace id, never a path. */
  workspace: z
    .string()
    .regex(/^[a-z0-9]{4,24}$/)
    .optional(),
  minimized: z.boolean(),
});

type LayoutNode =
  | { kind: 'pane'; key: number }
  | {
      kind: 'split';
      direction: 'row' | 'column';
      children: { node: LayoutNode; weight: number }[];
    };

function layoutNode(depth: number): z.ZodType<LayoutNode> {
  const pane = z.object({ kind: z.literal('pane'), key });
  if (depth >= MAX_DEPTH) return pane;
  return z.union([
    pane,
    z.object({
      kind: z.literal('split'),
      direction: z.enum(['row', 'column']),
      children: z
        .array(
          z.object({
            node: z.lazy(() => layoutNode(depth + 1)),
            weight: z.number().positive().max(1_000_000),
          }),
        )
        .min(1)
        .max(MAX_SESSIONS),
    }),
  ]);
}

export const workspaceStateSchema = z.object({
  version: z.literal(1),
  sessions: z.array(sessionSchema).max(MAX_SESSIONS),
  layout: z.object({ root: layoutNode(0).optional() }),
  focused: key.optional(),
  zoomed: key.optional(),
  sidebar: z.boolean(),
  access: z.enum(['edit', 'full']),
});

export type WorkspaceState = z.infer<typeof workspaceStateSchema>;

/** `<userData>/workspaces/<first 16 hex of sha256(project)>.json`: one file per project. */
export function workspaceStateFile(userData: string, project: string): string {
  let folder = resolve(project);
  if (process.platform === 'win32') folder = folder.toLowerCase();
  const hash = createHash('sha256').update(folder).digest('hex').slice(0, 16);
  return join(userData, 'workspaces', `${hash}.json`);
}

/** The saved state, or undefined when there is none or it does not validate. */
export function readWorkspaceState(file: string): WorkspaceState | undefined {
  try {
    const parsed = workspaceStateSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Validates what the page sent and writes it. Returns false, writing nothing, for anything that
 * is not a workspace state or is too large; a convenience must never fill the disk.
 */
export function writeWorkspaceState(file: string, state: unknown): boolean {
  const parsed = workspaceStateSchema.safeParse(state);
  if (!parsed.success) return false;
  const text = JSON.stringify(parsed.data);
  if (Buffer.byteLength(text) > WORKSPACE_STATE_MAX_BYTES) return false;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return true;
  } catch {
    // The workspace still works; it only opens with one shell next time.
    return false;
  }
}
