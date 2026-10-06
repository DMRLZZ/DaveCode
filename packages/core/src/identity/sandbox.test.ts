import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountDir, SandboxManager } from './sandbox';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'davecode-sandboxes-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('SandboxManager', () => {
  it('creates and removes per-account directories', () => {
    const sandboxes = new SandboxManager(root);
    const dir = sandboxes.ensure('acc_123');
    expect(dir).toBe(join(root, 'acc_123'));
    expect(statSync(dir).isDirectory()).toBe(true);
    // Idempotent.
    expect(sandboxes.ensure('acc_123')).toBe(dir);
    writeFileSync(join(dir, 'credentials.json'), '{}');
    sandboxes.remove('acc_123');
    expect(existsSync(dir)).toBe(false);
    // Removing a missing sandbox is a no-op.
    expect(() => sandboxes.remove('acc_123')).not.toThrow();
  });

  it('maps CLI providers to their config env var', () => {
    const sandboxes = new SandboxManager(root);
    expect(sandboxes.envFor({ id: 'acc_1', provider: 'claude-cli' })).toEqual({
      CLAUDE_CONFIG_DIR: join(root, 'acc_1'),
    });
    expect(sandboxes.envFor({ id: 'acc_2', provider: 'codex-cli' })).toEqual({
      CODEX_HOME: join(root, 'acc_2'),
    });
    expect(sandboxes.envFor({ id: 'acc_3', provider: 'openai' })).toEqual({});
    expect(sandboxes.envFor({ id: 'acc_4', provider: 'gemini-web' })).toEqual({});
  });

  it.each([
    '..',
    '../escape',
    'a/../../b',
    'a/b',
    'a\\b',
    'C:\\Windows',
    '/etc',
    '',
    '.hidden',
    'NUL',
    'com1',
    'x'.repeat(200),
  ])('rejects unsafe id %j', (id) => {
    const sandboxes = new SandboxManager(root);
    expect(() => sandboxes.ensure(id)).toThrow();
    expect(() => sandboxes.remove(id)).toThrow();
    expect(() => accountDir(root, id)).toThrow();
  });
});
