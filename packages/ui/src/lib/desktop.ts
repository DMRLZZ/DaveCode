export type PaneKind = 'shell' | 'claude' | 'codex' | 'agy' | 'davecode';

export interface TerminalBridge {
  open(request: { kind: PaneKind; cols: number; rows: number }): Promise<string>;
  write(request: { id: string; data: string }): Promise<void>;
  resize(request: { id: string; cols: number; rows: number }): Promise<void>;
  close(id: string): Promise<void>;
  copy(text: string): Promise<void>;
  onData(listener: (id: string, data: string) => void): () => void;
  onExit(listener: (id: string, code: number) => void): () => void;
}

/** Present only inside the desktop app; a browser tab cannot open local terminals. */
export function terminalBridge(): TerminalBridge | undefined {
  return (window as unknown as { davecodeDesktop?: { terminal?: TerminalBridge } }).davecodeDesktop
    ?.terminal;
}

/** Columns of the pane grid: one pane fills the window, then 2 × 2, then 3 across. */
export function gridColumns(panes: number): number {
  if (panes <= 1) return 1;
  return panes <= 4 ? 2 : 3;
}
