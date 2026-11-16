export type PaneKind = 'shell' | 'claude' | 'codex' | 'agy' | 'davecode';

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
  onData(listener: (id: string, data: string) => void): () => void;
  onExit(listener: (id: string, code: number) => void): () => void;
}

interface DesktopBridge {
  terminal?: TerminalBridge;
  chooseProject?: () => Promise<void>;
}

function desktop(): DesktopBridge | undefined {
  return (window as unknown as { davecodeDesktop?: DesktopBridge }).davecodeDesktop;
}

/** Present only inside the desktop app; a browser tab cannot open local terminals. */
export function terminalBridge(): TerminalBridge | undefined {
  return desktop()?.terminal;
}

/** Opens the desktop app's folder picker to switch projects; absent in a browser tab. */
export function chooseProject(): (() => void) | undefined {
  const choose = desktop()?.chooseProject;
  return choose ? () => void choose() : undefined;
}
