import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The shells a Windows pane can open. Elsewhere the user's own login shell is used. */
export const SHELL_IDS = ['auto', 'powershell', 'pwsh', 'cmd', 'gitbash', 'wsl'] as const;
export type ShellId = (typeof SHELL_IDS)[number];

export interface ShellPlan {
  file: string;
  args: string[];
}

/** Where each shell's executable is, or undefined when it is not installed. */
export interface ShellLocations {
  powershell?: string | undefined;
  pwsh?: string | undefined;
  cmd?: string | undefined;
  gitbash?: string | undefined;
  wsl?: string | undefined;
}

function where(command: string): string | undefined {
  const found = spawnSync('where.exe', [command], { windowsHide: true, encoding: 'utf8' });
  if (found.status !== 0) return undefined;
  return found.stdout
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim();
}

/** Git Bash ships next to git: `…\Git\cmd\git.exe` → `…\Git\bin\bash.exe`. */
export function gitBashFrom(gitPath: string | undefined): string | undefined {
  if (!gitPath) return undefined;
  const root = dirname(dirname(gitPath));
  const bash = join(root, 'bin', 'bash.exe');
  return existsSync(bash) ? bash : undefined;
}

/** WSL counts only with a Linux distribution installed; `wsl.exe` alone is on every Windows. */
function wslWithDistro(): string | undefined {
  const wsl = where('wsl.exe');
  if (!wsl) return undefined;
  const list = spawnSync(wsl, ['--list', '--quiet'], {
    windowsHide: true,
    encoding: 'utf16le',
    timeout: 5000,
  });
  return list.status === 0 && list.stdout.replace(/\0/g, '').trim() ? wsl : undefined;
}

/** Looks the Windows shells up once; costs a few short `where.exe` calls. */
export function locateWindowsShells(): ShellLocations {
  return {
    powershell: where('powershell.exe'),
    pwsh: where('pwsh.exe'),
    cmd: where('cmd.exe'),
    gitbash:
      gitBashFrom(where('git.exe')) ??
      [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
        .filter((dir): dir is string => Boolean(dir))
        .map((dir) => join(dir, 'Git', 'bin', 'bash.exe'))
        .find((path) => existsSync(path)),
    wsl: wslWithDistro(),
  };
}

/** The shell `auto` means on Windows: PowerShell 7 when installed, else Windows PowerShell. */
export function resolveShell(choice: ShellId, found: ShellLocations): Exclude<ShellId, 'auto'> {
  if (choice !== 'auto' && found[choice]) return choice;
  return found.pwsh ? 'pwsh' : 'powershell';
}

/**
 * How a pane starts on Windows. An agent runs inside the shell, so PATH, profiles and `.cmd`
 * shims resolve as in any other terminal, and the shell stays open when the agent exits.
 */
export function windowsShellPlan(
  shell: Exclude<ShellId, 'auto'>,
  found: ShellLocations,
  command: string | undefined,
): ShellPlan {
  switch (shell) {
    case 'cmd':
      return { file: found.cmd ?? 'cmd.exe', args: command ? ['/K', command] : [] };
    case 'gitbash': {
      const file = found.gitbash ?? 'bash.exe';
      return {
        file,
        args: command
          ? ['--login', '-i', '-c', `${command}; exec bash --login -i`]
          : ['--login', '-i'],
      };
    }
    case 'wsl':
      // WSL starts in the Windows folder the pane was opened in, translated to /mnt/….
      return {
        file: found.wsl ?? 'wsl.exe',
        args: command ? ['-e', 'bash', '-lic', `${command}; exec bash -li`] : [],
      };
    default: {
      const file = (shell === 'pwsh' ? found.pwsh : found.powershell) ?? `${shell}.exe`;
      return { file, args: command ? ['-NoLogo', '-NoExit', '-Command', command] : ['-NoLogo'] };
    }
  }
}

/** macOS and Linux: the user's login shell, interactive, so their PATH and aliases load. */
export function posixShellPlan(shell: string, command: string | undefined): ShellPlan {
  return { file: shell, args: command ? ['-ilc', `${command}; exec "${shell}" -il`] : ['-il'] };
}
