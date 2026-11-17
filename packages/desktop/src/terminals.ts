import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { IPty, spawn as ptySpawn } from '@lydell/node-pty';
import { agentCommand } from './agents';
import { type PaneKind, paneEnv } from './panes';
import {
  locateWindowsShells,
  posixShellPlan,
  resolveShell,
  type ShellId,
  type ShellLocations,
  type ShellPlan,
  windowsShellPlan,
} from './shells';

type Pty = { spawn: typeof ptySpawn };

export interface TerminalEvents {
  data(id: string, data: string): void;
  exit(id: string, code: number): void;
}

/** How new panes start; read from the preferences each time a pane opens. */
export interface LaunchOptions {
  shell: ShellId;
  yolo: boolean;
}

/** Owns the pseudo-terminals behind the panes. All of them die with the project or the window. */
export class Terminals {
  private readonly panes = new Map<string, IPty>();
  private module: Pty | undefined;
  private windowsShells: ShellLocations | undefined;

  constructor(
    /** The bundled runtime carries the native module, outside the app's asar archive. */
    private readonly runtimeDir: string,
    private readonly events: TerminalEvents,
    private readonly launch: () => LaunchOptions,
  ) {}

  private load(): Pty {
    this.module ??= createRequire(join(this.runtimeDir, 'package.json'))('@lydell/node-pty') as Pty;
    return this.module;
  }

  /** The Windows shells found on this machine, looked up once. */
  shells(): ShellLocations {
    this.windowsShells ??= process.platform === 'win32' ? locateWindowsShells() : {};
    return this.windowsShells;
  }

  plan(kind: PaneKind): ShellPlan {
    const { shell, yolo } = this.launch();
    const command = kind === 'shell' ? undefined : agentCommand(kind, yolo);
    if (process.platform !== 'win32') {
      return posixShellPlan(process.env.SHELL || '/bin/bash', command);
    }
    const found = this.shells();
    return windowsShellPlan(resolveShell(shell, found), found, command);
  }

  open(kind: PaneKind, cwd: string, cols: number, rows: number): string {
    const plan = this.plan(kind);
    const pty = this.load().spawn(plan.file, plan.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: paneEnv(process.env),
    });
    const id = randomUUID();
    this.panes.set(id, pty);
    pty.onData((data) => this.events.data(id, data));
    pty.onExit(({ exitCode }) => {
      if (this.panes.delete(id)) this.events.exit(id, exitCode);
    });
    return id;
  }

  write(id: string, data: string): void {
    this.panes.get(id)?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.panes.get(id)?.resize(cols, rows);
    } catch {
      /* The process can exit between the renderer's resize and this call. */
    }
  }

  close(id: string): void {
    const pty = this.panes.get(id);
    if (!pty) return;
    this.panes.delete(id);
    try {
      pty.kill();
    } catch {
      /* Already gone. */
    }
  }

  closeAll(): void {
    for (const id of [...this.panes.keys()]) this.close(id);
  }
}
