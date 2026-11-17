import type { AgentId } from './agents';

export type PaneKind = 'shell' | AgentId;

export interface TerminalBridge {
  /** `workspace` opens the pane in that isolated worktree instead of the project checkout. */
  open(request: {
    kind: PaneKind;
    cols: number;
    rows: number;
    workspace?: string;
  }): Promise<string>;
  write(request: { id: string; data: string }): Promise<void>;
  resize(request: { id: string; cols: number; rows: number }): Promise<void>;
  close(id: string): Promise<void>;
  copy(text: string): Promise<void>;
  /** The system clipboard, for right-click paste. Missing before 0.9. */
  readClipboard?(): Promise<string>;
  onData(listener: (id: string, data: string) => void): () => void;
  onExit(listener: (id: string, code: number) => void): () => void;
}

/** Keeps the project's sessions and pane layout across launches (the app owns the file). */
export interface WorkspaceBridge {
  /** The state saved for the open project, already validated by the app, or nothing. */
  load(): Promise<unknown>;
  save(state: unknown): Promise<unknown>;
}

/** What a click on a desktop notification brings up. */
export type NotificationTarget = { kind: 'pane'; key: number } | { kind: 'run'; id: string };

export interface DesktopNotification {
  title: string;
  body: string;
  target?: NotificationTarget;
}

interface DesktopBridge {
  platform?: string;
  terminal?: TerminalBridge;
  chooseProject?: () => Promise<void>;
  workspace?: WorkspaceBridge;
  preferences?: { load(): Promise<unknown>; save(value: unknown): Promise<unknown> };
  detectAgents?: () => Promise<unknown>;
  detectShells?: () => Promise<unknown>;
  notify?: (request: DesktopNotification) => Promise<unknown>;
  onNotificationClick?: (listener: (target: unknown) => void) => () => void;
}

function desktop(): DesktopBridge | undefined {
  return (window as unknown as { davecodeDesktop?: DesktopBridge }).davecodeDesktop;
}

/** Present only inside the desktop app; a browser tab cannot open local terminals. */
export function terminalBridge(): TerminalBridge | undefined {
  return desktop()?.terminal;
}

/** Absent in a browser tab and in desktop apps older than 0.8. */
export function workspaceBridge(): WorkspaceBridge | undefined {
  return desktop()?.workspace;
}

/** The operating system the desktop app runs on, or undefined in a browser tab. */
export function desktopPlatform(): string | undefined {
  return desktop()?.platform;
}

/** The app's own preference file; absent in a browser tab and before 0.9. */
export function preferencesBridge() {
  return desktop()?.preferences;
}

/** Which agent CLIs and Windows shells are installed, as `{ id, installed }` lists. */
export async function detectInstalled(what: 'agents' | 'shells'): Promise<Map<string, boolean>> {
  const bridge = desktop();
  const detect = what === 'agents' ? bridge?.detectAgents : bridge?.detectShells;
  const found = new Map<string, boolean>();
  if (!detect) return found;
  try {
    const list = await detect();
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item && typeof item.id === 'string' && typeof item.installed === 'boolean') {
          found.set(item.id, item.installed);
        }
      }
    }
  } catch {
    /* Nothing detected: everything is offered as not installed. */
  }
  return found;
}

/** Shows a system notification through the app; false when there is no app to show it. */
export async function desktopNotify(request: DesktopNotification): Promise<boolean> {
  const notify = desktop()?.notify;
  if (!notify) return false;
  try {
    return (await notify(request)) === true;
  } catch {
    return false;
  }
}

export function onNotificationClick(listener: (target: NotificationTarget) => void): () => void {
  const subscribe = desktop()?.onNotificationClick;
  if (!subscribe) return () => {};
  return subscribe((target) => {
    if (typeof target !== 'object' || target === null) return;
    const value = target as Record<string, unknown>;
    if (value.kind === 'pane' && typeof value.key === 'number') {
      listener({ kind: 'pane', key: value.key });
    } else if (value.kind === 'run' && typeof value.id === 'string') {
      listener({ kind: 'run', id: value.id });
    }
  });
}

/** Opens the desktop app's folder picker to switch projects; absent in a browser tab. */
export function chooseProject(): (() => void) | undefined {
  const choose = desktop()?.chooseProject;
  return choose ? () => void choose() : undefined;
}
