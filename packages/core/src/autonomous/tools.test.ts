import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PathEscapeError, resolveRepoPath, TOOL_DEFINITIONS, WorkspaceTools } from './tools';

let root: string;
let outside: string;
let tools: WorkspaceTools;

const args = (value: Record<string, unknown>) => JSON.stringify(value);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'davecode-tools-'));
  outside = mkdtempSync(join(tmpdir(), 'davecode-outside-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
  mkdirSync(join(root, '.davecode'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
  writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'export const a = 1;\n');
  writeFileSync(join(root, '.davecode', 'STATE.md'), '# state\n');
  writeFileSync(join(outside, 'secret.txt'), 'top secret');
  tools = new WorkspaceTools({ root, commandTimeoutMs: 20_000 });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('resolveRepoPath', () => {
  it('accepts relative and absolute paths inside the root', async () => {
    expect((await resolveRepoPath(root, 'src/a.ts')).rel).toBe('src/a.ts');
    expect((await resolveRepoPath(root, join(root, 'src', 'a.ts'))).rel).toBe('src/a.ts');
    expect((await resolveRepoPath(root, 'src/new/file.ts', 'write')).rel).toBe('src/new/file.ts');
    expect((await resolveRepoPath(root, '.')).rel).toBe('.');
  });

  it('rejects escapes, absolute outside paths, .git and brain writes', async () => {
    await expect(resolveRepoPath(root, '../x')).rejects.toBeInstanceOf(PathEscapeError);
    await expect(resolveRepoPath(root, 'src/../../x')).rejects.toBeInstanceOf(PathEscapeError);
    await expect(resolveRepoPath(root, join(outside, 'secret.txt'))).rejects.toBeInstanceOf(
      PathEscapeError,
    );
    await expect(resolveRepoPath(root, '.git/config')).rejects.toBeInstanceOf(PathEscapeError);
    await expect(resolveRepoPath(root, 'a\0b')).rejects.toBeInstanceOf(PathEscapeError);
    await expect(resolveRepoPath(root, '.davecode/STATE.md', 'write')).rejects.toBeInstanceOf(
      PathEscapeError,
    );
    expect((await resolveRepoPath(root, '.davecode/STATE.md')).rel).toBe('.davecode/STATE.md');
  });

  it('rejects symlinks that point outside the root', async () => {
    try {
      symlinkSync(outside, join(root, 'link'), 'junction');
    } catch {
      return; // symlinks not permitted on this machine
    }
    await expect(resolveRepoPath(root, 'link/secret.txt')).rejects.toThrow(/symlink/);
    await expect(resolveRepoPath(root, 'link/new.txt', 'write')).rejects.toThrow(/symlink/);
    const out = await tools.call('read_file', args({ path: 'link/secret.txt' }));
    expect(out.ok).toBe(false);
    expect(out.output).not.toContain('top secret');
  });
});

describe('WorkspaceTools', () => {
  it('exposes OpenAI tool definitions including finish', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.function.name)).toEqual([
      'list_dir',
      'read_file',
      'write_file',
      'edit_file',
      'search',
      'run_command',
      'finish',
    ]);
  });

  it('lists, reads, writes and tracks changed files', async () => {
    expect((await tools.call('list_dir', '{}')).output).toContain('src/');
    expect((await tools.call('read_file', args({ path: 'src/a.ts' }))).output).toContain('a = 1');
    expect((await tools.call('read_file', args({ path: 'src/a.ts', offset: 2 }))).output).toBe(
      'export const b = 2;\n',
    );
    const written = await tools.call('write_file', args({ path: 'src/deep/b.ts', content: 'x' }));
    expect(written.ok).toBe(true);
    expect(readFileSync(join(root, 'src', 'deep', 'b.ts'), 'utf8')).toBe('x');
    expect([...tools.changedFiles]).toEqual(['src/deep/b.ts']);
  });

  it('edits with a unique exact match only', async () => {
    const ok = await tools.call(
      'edit_file',
      args({ path: 'src/a.ts', old_string: 'a = 1', new_string: 'a = 10' }),
    );
    expect(ok.ok).toBe(true);
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toContain('a = 10;');
    const missing = await tools.call(
      'edit_file',
      args({ path: 'src/a.ts', old_string: 'nope', new_string: 'x' }),
    );
    expect(missing).toMatchObject({ ok: false });
    expect(missing.output).toMatch(/not found/);
    const ambiguous = await tools.call(
      'edit_file',
      args({ path: 'src/a.ts', old_string: 'export const', new_string: 'x' }),
    );
    expect(ambiguous.output).toMatch(/matches 2 times/);
  });

  it('edits CRLF files with LF old_string', async () => {
    writeFileSync(join(root, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
    const res = await tools.call(
      'edit_file',
      args({ path: 'crlf.txt', old_string: 'one\ntwo', new_string: 'uno\ndos' }),
    );
    expect(res.ok).toBe(true);
    expect(readFileSync(join(root, 'crlf.txt'), 'utf8')).toBe('uno\r\ndos\r\nthree\r\n');
  });

  it('searches files, skipping node_modules', async () => {
    const res = await tools.call('search', args({ query: 'export const a' }));
    expect(res.output).toContain('src/a.ts:1:');
    expect(res.output).not.toContain('node_modules');
    const re = await tools.call('search', args({ query: 'const [ab] = 2', regex: true }));
    expect(re.output).toContain('src/a.ts:2:');
    const bad = await tools.call('search', args({ query: '(', regex: true }));
    expect(bad.ok).toBe(false);
  });

  it('refuses writes outside the root and into the brain', async () => {
    const res = await tools.call('write_file', args({ path: '../evil.txt', content: 'x' }));
    expect(res.ok).toBe(false);
    expect(res.output).toMatch(/outside the repository/);
    const brain = await tools.call('write_file', args({ path: '.davecode/x.md', content: 'x' }));
    expect(brain.ok).toBe(false);
  });

  it('reports invalid arguments and unknown tools instead of throwing', async () => {
    expect((await tools.call('read_file', 'not json')).output).toMatch(/not valid JSON/);
    expect((await tools.call('read_file', '{}')).output).toMatch(/path/);
    expect((await tools.call('rm_rf', '{}')).output).toMatch(/unknown tool/);
  });

  it('returns the finish summary', async () => {
    const res = await tools.call('finish', args({ summary: 'done' }));
    expect(res.finished).toEqual({ summary: 'done' });
  });

  it('enforces the command allow-list and read-only git', async () => {
    expect(() => tools.assertCommandAllowed('bash', ['-c', 'rm -rf /'])).toThrow(/not allowed/);
    expect(() => tools.assertCommandAllowed('/usr/bin/node', [])).toThrow(/bare executable/);
    expect(() => tools.assertCommandAllowed('git', ['push', '--force'])).toThrow(/read-only/);
    expect(() => tools.assertCommandAllowed('git', ['-c', 'x=y', 'status'])).toThrow(/read-only/);
    expect(() => tools.assertCommandAllowed('git', ['diff', '--output=x'])).toThrow(/not allowed/);
    expect(() => tools.assertCommandAllowed('git', ['status'])).not.toThrow();
    expect(() => tools.assertCommandAllowed('node.exe', ['-v'])).not.toThrow();
    const denied = await tools.call('run_command', args({ command: 'curl', args: ['x'] }));
    expect(denied.ok).toBe(false);
  });

  it('runs allowed commands without a shell and captures output', async () => {
    const res = await tools.call(
      'run_command',
      args({ command: 'node', args: ['-e', 'console.log("hi && echo x"); process.exit(3)'] }),
    );
    expect(res.ok).toBe(false);
    expect(res.output).toContain('exit code 3');
    expect(res.output).toContain('hi && echo x');
  });

  it('accepts a whole command line in `command` and still checks the allow-list', async () => {
    const ok = await tools.call('run_command', args({ command: 'node -e "console.log(41 + 1)"' }));
    expect(ok.ok).toBe(true);
    expect(ok.output).toContain('42');
    const denied = await tools.call('run_command', args({ command: 'curl https://example.com' }));
    expect(denied.ok).toBe(false);
    expect(denied.output).toMatch(/"curl" is not allowed/);
  });
});
