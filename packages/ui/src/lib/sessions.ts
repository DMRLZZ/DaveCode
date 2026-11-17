/**
 * Small pure rules of the terminal workspace: how sessions are named and which key presses
 * belong to the workspace instead of the shell inside a pane.
 */

export const SESSION_NAME_MAX_LENGTH = 40;

/** `Claude Code`, then `Claude Code 2`, `Claude Code 3`… whatever is not taken yet. */
export function uniqueSessionName(base: string, taken: readonly string[]): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** The name the user typed, tidied; an empty one keeps the previous name. */
export function cleanSessionName(draft: string, previous: string): string {
  const name = draft.replace(/\s+/g, ' ').trim().slice(0, SESSION_NAME_MAX_LENGTH).trim();
  return name === '' ? previous : name;
}

export type WorkspaceAction =
  | 'split-right'
  | 'split-down'
  | 'minimize'
  | 'zoom'
  | 'close'
  | 'sidebar'
  | 'new-agent';

const KEYS: Record<string, WorkspaceAction> = {
  d: 'split-right',
  e: 'split-down',
  m: 'minimize',
  enter: 'zoom',
  w: 'close',
  b: 'sidebar',
  t: 'new-agent',
};

/** What the keyboard shows next to each action. */
export const SHORTCUT_LABEL: Record<WorkspaceAction, string> = {
  'split-right': 'Ctrl+Shift+D',
  'split-down': 'Ctrl+Shift+E',
  minimize: 'Ctrl+Shift+M',
  zoom: 'Ctrl+Shift+Enter',
  close: 'Ctrl+Shift+W',
  sidebar: 'Ctrl+Shift+B',
  'new-agent': 'Ctrl+Shift+T',
};

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>;

/** Ctrl (or ⌘) + Shift + a letter: free in every shell, where Ctrl+letter alone is taken. */
export function workspaceAction(event: KeyLike): WorkspaceAction | undefined {
  if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return undefined;
  return KEYS[event.key.toLowerCase()];
}

export function isWorkspaceShortcut(event: KeyLike): boolean {
  return workspaceAction(event) !== undefined;
}
