/**
 * File and command tools exposed to the built-in executor through OpenAI tool calling.
 * Every path is confined to the repository root (no absolute paths outside it, no `..`
 * escapes, no symlink escapes); `.git` is off-limits and `.davecode` (the project brain,
 * owned by the runner) is read-only.
 */
import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ToolDefinition } from '../types';
import { projectEnv, runProcess, truncateHead, truncateTail } from './process';

/** Thrown (and reported to the model) when a path would leave the repository. */
export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathEscapeError';
  }
}

/** Default `runner.allowedCommands`. */
export const DEFAULT_ALLOWED_COMMANDS: readonly string[] = [
  'pnpm',
  'npm',
  'npx',
  'node',
  'git',
  'tsc',
  'biome',
  'vitest',
];

/** git subcommands `run_command` accepts: none of them modify the repository. */
export const READ_ONLY_GIT_SUBCOMMANDS: readonly string[] = [
  'status',
  'diff',
  'log',
  'show',
  'ls-files',
  'grep',
  'rev-parse',
  'blame',
  'shortlog',
  'describe',
];

/** Directories `search` never descends into. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'build', '.next', '.turbo']);
const MAX_FILE_BYTES = 1024 * 1024;

const isWindows = process.platform === 'win32';
const same = (a: string, b: string) => (isWindows ? a.toLowerCase() === b.toLowerCase() : a === b);

function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** realpath of the deepest existing ancestor, with the missing tail re-appended. */
async function realpathLenient(target: string): Promise<string> {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length > 0 ? path.join(real, ...missing.reverse()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      const parent = path.dirname(current);
      if (parent === current) return target;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export interface ResolvedPath {
  /** Absolute path (inside the root). */
  abs: string;
  /** Path relative to the root with forward slashes (`.` for the root itself). */
  rel: string;
}

/**
 * Resolves a model-supplied path inside `root`. Rejects NUL bytes, absolute paths outside the
 * root, `..` escapes, symlinks that point outside, anything under `.git`, and (for writes)
 * anything under `.davecode`.
 */
export async function resolveRepoPath(
  root: string,
  input: string,
  mode: 'read' | 'write' = 'read',
): Promise<ResolvedPath> {
  if (input.includes('\0')) throw new PathEscapeError('path contains a NUL byte');
  const base = path.resolve(root);
  const abs = path.resolve(base, input.trim() === '' ? '.' : input);
  if (!isInside(base, abs)) {
    throw new PathEscapeError(`path "${input}" is outside the repository`);
  }
  const realBase = await realpath(base);
  const real = await realpathLenient(abs);
  if (!isInside(realBase, real)) {
    throw new PathEscapeError(`path "${input}" resolves outside the repository (symlink)`);
  }
  const rel = path.relative(base, abs).split(path.sep).join('/') || '.';
  const first = rel.split('/')[0] ?? '';
  if (same(first, '.git')) throw new PathEscapeError('the .git directory is off-limits');
  if (mode === 'write' && same(first, '.davecode')) {
    throw new PathEscapeError('.davecode is managed by the runner and is read-only for tools');
  }
  return { abs, rel };
}

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const listDirArgs = z.object({ path: z.string().default('.') });
const readFileArgs = z.object({
  path: z.string().min(1),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).optional(),
});
const writeFileArgs = z.object({ path: z.string().min(1), content: z.string() });
const editFileArgs = z.object({
  path: z.string().min(1),
  old_string: z.string().min(1),
  new_string: z.string(),
});
const searchArgs = z.object({
  query: z.string().min(1),
  regex: z.boolean().default(false),
  case_sensitive: z.boolean().default(false),
  path: z.string().default('.'),
  max_results: z.number().int().min(1).max(500).default(50),
});
const runCommandArgs = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
});
const finishArgs = z.object({ summary: z.string().min(1) });

function fn(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
    },
  };
}

const str = (description: string) => ({ type: 'string', description });

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  fn(
    'list_dir',
    'List the entries of a directory in the repository (directories end with "/").',
    { path: str('Directory relative to the repository root (default ".").') },
    [],
  ),
  fn(
    'read_file',
    'Read a UTF-8 text file. Large files are truncated; use offset/limit (1-based lines) to page.',
    {
      path: str('File path relative to the repository root.'),
      offset: { type: 'integer', minimum: 1, description: 'First line to return (1-based).' },
      limit: { type: 'integer', minimum: 1, description: 'Number of lines to return.' },
    },
    ['path'],
  ),
  fn(
    'write_file',
    'Create or overwrite a file with the given content. Parent directories are created.',
    { path: str('File path relative to the repository root.'), content: str('Full content.') },
    ['path', 'content'],
  ),
  fn(
    'edit_file',
    'Replace one exact occurrence of old_string with new_string. old_string must match exactly ' +
      'once (include surrounding lines to make it unique).',
    {
      path: str('File path relative to the repository root.'),
      old_string: str('Exact text to replace (must be unique in the file).'),
      new_string: str('Replacement text.'),
    },
    ['path', 'old_string', 'new_string'],
  ),
  fn(
    'search',
    'Search file contents (substring or regex). Skips node_modules, .git, dist and coverage.',
    {
      query: str('Text or regular expression to find.'),
      regex: { type: 'boolean', description: 'Treat query as a regular expression.' },
      case_sensitive: { type: 'boolean', description: 'Case-sensitive match (default false).' },
      path: str('Directory or file to search (default ".").'),
      max_results: { type: 'integer', minimum: 1, maximum: 500 },
    },
    ['query'],
  ),
  fn(
    'run_command',
    'Run an allow-listed executable in the repository root without a shell (e.g. command ' +
      '"pnpm", args ["test"]). No pipes, redirects or globbing. git is limited to read-only ' +
      'subcommands. Output is truncated.',
    {
      command: str('Executable name, e.g. "pnpm", "node", "git".'),
      args: { type: 'array', items: { type: 'string' }, description: 'Arguments.' },
    },
    ['command'],
  ),
  fn(
    'finish',
    'Call when the task is fully implemented. The runner then runs the quality gates.',
    { summary: str('Concise summary of the changes, suitable for a commit message body.') },
    ['summary'],
  ),
];

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface WorkspaceToolsOptions {
  root: string;
  /** Executables `run_command` may start (default {@link DEFAULT_ALLOWED_COMMANDS}). */
  allowedCommands?: readonly string[];
  /** Timeout for one `run_command` (default 10 min). */
  commandTimeoutMs?: number;
  /** Characters returned to the model per tool result (default 16 000). */
  maxOutputChars?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ToolOutcome {
  /** Text returned to the model as the tool message. */
  output: string;
  ok: boolean;
  /** Set when the model called `finish`. */
  finished?: { summary: string };
}

class ToolInputError extends Error {}

function parseArgs<T>(schema: z.ZodType<T>, raw: string): T {
  let value: unknown;
  try {
    value = raw.trim() === '' ? {} : JSON.parse(raw);
  } catch {
    throw new ToolInputError('arguments are not valid JSON');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ToolInputError(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; '),
    );
  }
  return parsed.data;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

const commandName = (command: string) =>
  path
    .basename(command)
    .replace(/\.(exe|cmd|bat|com)$/i, '')
    .toLowerCase();

/** The workspace tool belt for one repository. */
export class WorkspaceTools {
  readonly root: string;
  readonly allowedCommands: readonly string[];
  /** Repository-relative paths written or edited so far. */
  readonly changedFiles = new Set<string>();
  /** Successful write_file/edit_file calls so far (grows even when a file is edited again). */
  writeCount = 0;
  private readonly commandTimeoutMs: number;
  private readonly maxOutput: number;
  private readonly env: NodeJS.ProcessEnv | undefined;

  constructor(opts: WorkspaceToolsOptions) {
    this.root = path.resolve(opts.root);
    this.allowedCommands = (opts.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS).map((c) =>
      c.toLowerCase(),
    );
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 600_000;
    this.maxOutput = opts.maxOutputChars ?? 16_000;
    this.env = opts.env;
  }

  definitions(): ToolDefinition[] {
    return [...TOOL_DEFINITIONS];
  }

  /** Executes one tool call. Never throws for bad input: errors become `ok: false` results. */
  async call(name: string, rawArgs: string, signal?: AbortSignal): Promise<ToolOutcome> {
    try {
      switch (name) {
        case 'list_dir':
          return this.ok(await this.listDir(parseArgs(listDirArgs, rawArgs)));
        case 'read_file':
          return this.ok(await this.readFile(parseArgs(readFileArgs, rawArgs)));
        case 'write_file':
          return this.ok(await this.writeFile(parseArgs(writeFileArgs, rawArgs)));
        case 'edit_file':
          return this.ok(await this.editFile(parseArgs(editFileArgs, rawArgs)));
        case 'search':
          return this.ok(await this.search(parseArgs(searchArgs, rawArgs)));
        case 'run_command':
          return await this.runCommand(parseArgs(runCommandArgs, rawArgs), signal);
        case 'finish': {
          const { summary } = parseArgs(finishArgs, rawArgs);
          return {
            ok: true,
            output: 'Finished. The runner will now validate.',
            finished: { summary },
          };
        }
        default:
          return { ok: false, output: `Error: unknown tool "${name}"` };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `Error: ${message}` };
    }
  }

  private ok(output: string): ToolOutcome {
    return { ok: true, output };
  }

  private async listDir(args: z.infer<typeof listDirArgs>): Promise<string> {
    const { abs, rel } = await resolveRepoPath(this.root, args.path);
    const entries = await readdir(abs, { withFileTypes: true });
    const names = entries
      .filter((e) => !(rel === '.' && e.name === '.git'))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    const shown = names.slice(0, 500);
    const more = names.length > shown.length ? `\n[… ${names.length - shown.length} more]` : '';
    return shown.length > 0 ? `${shown.join('\n')}${more}` : '(empty directory)';
  }

  private async readFile(args: z.infer<typeof readFileArgs>): Promise<string> {
    const { abs, rel } = await resolveRepoPath(this.root, args.path);
    const info = await stat(abs);
    if (!info.isFile()) throw new ToolInputError(`${rel} is not a file`);
    const buffer = await readFile(abs);
    if (buffer.subarray(0, 8000).includes(0)) throw new ToolInputError(`${rel} is a binary file`);
    let text = buffer.toString('utf8');
    if (args.offset !== undefined || args.limit !== undefined) {
      const lines = text.split('\n');
      const start = (args.offset ?? 1) - 1;
      text = lines.slice(start, args.limit ? start + args.limit : undefined).join('\n');
    }
    if (text.length > this.maxOutput) {
      return `${text.slice(0, this.maxOutput)}\n[… truncated: ${text.length - this.maxOutput} more characters; use offset/limit to read further]`;
    }
    return text;
  }

  private async writeFile(args: z.infer<typeof writeFileArgs>): Promise<string> {
    const { abs, rel } = await resolveRepoPath(this.root, args.path, 'write');
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, args.content, 'utf8');
    this.changedFiles.add(rel);
    this.writeCount++;
    return `Wrote ${Buffer.byteLength(args.content)} bytes to ${rel}`;
  }

  private async editFile(args: z.infer<typeof editFileArgs>): Promise<string> {
    const { abs, rel } = await resolveRepoPath(this.root, args.path, 'write');
    const text = await readFile(abs, 'utf8');
    let oldString = args.old_string;
    let newString = args.new_string;
    let count = countOccurrences(text, oldString);
    if (count === 0 && text.includes('\r\n') && !oldString.includes('\r\n')) {
      // The model usually sends LF; retry against a CRLF file.
      oldString = oldString.replace(/\n/g, '\r\n');
      newString = newString.replace(/\r?\n/g, '\r\n');
      count = countOccurrences(text, oldString);
    }
    if (count === 0) throw new ToolInputError(`old_string not found in ${rel}`);
    if (count > 1) {
      throw new ToolInputError(
        `old_string matches ${count} times in ${rel}; include more surrounding context`,
      );
    }
    const index = text.indexOf(oldString);
    const next = text.slice(0, index) + newString + text.slice(index + oldString.length);
    await writeFile(abs, next, 'utf8');
    this.changedFiles.add(rel);
    this.writeCount++;
    return `Edited ${rel}`;
  }

  private async search(args: z.infer<typeof searchArgs>): Promise<string> {
    const { abs } = await resolveRepoPath(this.root, args.path);
    let matcher: (line: string) => boolean;
    if (args.regex) {
      let re: RegExp;
      try {
        re = new RegExp(args.query, args.case_sensitive ? '' : 'i');
      } catch (err) {
        throw new ToolInputError(`invalid regex: ${err instanceof Error ? err.message : err}`);
      }
      matcher = (line) => re.test(line);
    } else {
      const needle = args.case_sensitive ? args.query : args.query.toLowerCase();
      matcher = (line) => (args.case_sensitive ? line : line.toLowerCase()).includes(needle);
    }

    const results: string[] = [];
    const visitFile = async (file: string) => {
      const info = await stat(file);
      if (info.size > MAX_FILE_BYTES) return;
      const buffer = await readFile(file);
      if (buffer.subarray(0, 8000).includes(0)) return;
      const lines = buffer.toString('utf8').split('\n');
      const rel = path.relative(this.root, file).split(path.sep).join('/');
      for (let i = 0; i < lines.length && results.length < args.max_results; i++) {
        const line = (lines[i] as string).replace(/\r$/, '');
        if (matcher(line)) results.push(`${rel}:${i + 1}: ${line.trim().slice(0, 300)}`);
      }
    };
    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (results.length >= args.max_results) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) await walk(full);
        } else if (entry.isFile()) {
          await visitFile(full);
        }
      }
    };

    const info = await stat(abs);
    if (info.isFile()) await visitFile(abs);
    else await walk(abs);
    if (results.length === 0) return 'No matches.';
    const capped = results.length >= args.max_results ? `\n[… capped at ${args.max_results}]` : '';
    return `${results.join('\n')}${capped}`;
  }

  /** Throws when `command args` is not permitted by the allow-list. */
  assertCommandAllowed(command: string, args: readonly string[]): void {
    if (/[\\/]/.test(command) || command.includes('\0')) {
      throw new ToolInputError('command must be a bare executable name, not a path');
    }
    const name = commandName(command);
    if (!this.allowedCommands.includes(name)) {
      throw new ToolInputError(
        `"${command}" is not allowed; allowed executables: ${this.allowedCommands.join(', ')}`,
      );
    }
    if (name === 'git') {
      const sub = args[0];
      if (!sub || !READ_ONLY_GIT_SUBCOMMANDS.includes(sub)) {
        throw new ToolInputError(
          `git is limited to read-only subcommands: ${READ_ONLY_GIT_SUBCOMMANDS.join(', ')}`,
        );
      }
      if (args.some((a) => /^--(output|ext-diff|exec)/.test(a))) {
        throw new ToolInputError('git options that write files or run programs are not allowed');
      }
    }
  }

  private async runCommand(
    args: z.infer<typeof runCommandArgs>,
    signal?: AbortSignal,
  ): Promise<ToolOutcome> {
    this.assertCommandAllowed(args.command, args.args);
    const result = await runProcess({
      command: args.command,
      args: args.args,
      cwd: this.root,
      timeoutMs: this.commandTimeoutMs,
      env: projectEnv(this.root, this.env ?? process.env),
      maxOutputChars: this.maxOutput,
      ...(signal ? { signal } : {}),
    });
    const half = Math.floor(this.maxOutput / 2);
    const status = result.timedOut
      ? `timed out after ${this.commandTimeoutMs} ms`
      : result.aborted
        ? 'aborted'
        : `exit code ${result.exitCode ?? 'none'}`;
    const output = [
      `$ ${[args.command, ...args.args].join(' ')}`,
      `${status} (${result.durationMs} ms)`,
      '--- stdout ---',
      truncateTail(result.stdout, half) || '(empty)',
      '--- stderr ---',
      truncateTail(result.stderr, half) || '(empty)',
    ].join('\n');
    return { ok: result.exitCode === 0, output: truncateHead(output, this.maxOutput + 500) };
  }
}
