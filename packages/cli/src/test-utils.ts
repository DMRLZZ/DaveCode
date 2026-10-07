/** Test helpers: captured IO, temp DaveCode homes and a one-call CLI runner. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliIO, OutStream } from './context';
import { runCli } from './program';
import { createTheme, type Theme } from './ui/theme';

export interface Captured extends OutStream {
  text(): string;
}

export function capture(isTTY = false, columns = 100): Captured {
  let buffer = '';
  return {
    isTTY,
    columns,
    write(chunk: string) {
      buffer += chunk;
      return true;
    },
    text: () => buffer,
  };
}

export interface TestIO extends CliIO {
  stdout: Captured;
  stderr: Captured;
}

export function testIO(options: { tty?: boolean; columns?: number } = {}): TestIO {
  return {
    stdout: capture(options.tty ?? false, options.columns ?? 100),
    stderr: capture(options.tty ?? false, options.columns ?? 100),
    stdin: { isTTY: options.tty ?? false },
  };
}

export interface TempDir {
  path: string;
  cleanup(): void;
}

export function tempDir(prefix = 'davecode-cli-'): TempDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/** A base environment that never points at the real `~/.davecode`. */
export function testEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DAVECODE_HOME: home,
    PATH: process.env.PATH,
    // Unicode glyphs on every platform, so snapshots match on legacy Windows consoles too.
    WT_SESSION: 'vitest',
    ...extra,
  };
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function cli(
  argv: string[],
  options: { home: string; cwd?: string; env?: NodeJS.ProcessEnv; tty?: boolean },
): Promise<CliResult> {
  const io = testIO({ tty: options.tty ?? false });
  const code = await runCli(argv, {
    io,
    env: testEnv(options.home, options.env),
    cwd: options.cwd ?? options.home,
  });
  return { code, stdout: io.stdout.text(), stderr: io.stderr.text() };
}

export const plain: Theme = createTheme({ color: false, unicode: true });
export const ascii: Theme = createTheme({ color: false, unicode: false });
