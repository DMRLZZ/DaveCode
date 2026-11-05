import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { IPty, spawn as ptySpawn } from '@lydell/node-pty';
import { type PaneKind, paneEnv, shellPlan } from './panes';

type Pty = { spawn: typeof ptySpawn };

function defaultShell(): string {
  if (process.platform !== 'win32') return process.env.SHELL || '/bin/bash';
  const found = spawnSync('where.exe', ['pwsh.exe'], { windowsHide: true, encoding: 'utf8' });
  return found.status === 0 ? 'pwsh.exe' : 'powershell.exe';
}

export interface TerminalEvents {
  data(id: string, data: string): void;
  exit(id: string, code: number): void;
}

/** Owns the pseudo-terminals behind the panes. All of them die with the project or the window. */
export class Terminals {
  private readonly panes = new Map<string, IPty>();
  private module: Pty | undefined;
  private shell: string | undefined;

  constructor(
    /** The bundled runtime carries the native module, outside the app's asar archive. */
    private readonly runtimeDir: string,
    private readonly events: TerminalEvents,
  ) {}

  private load(): Pty {
    this.module ??= createRequire(join(this.runtimeDir, 'package.json'))('@lydell/node-pty') as Pty;
    return this.module;
  }

  open(kind: PaneKind, cwd: string, cols: number, rows: number): string {
    this.shell ??= defaultShell();
    const plan = shellPlan(kind, process.platform, this.shell);
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
