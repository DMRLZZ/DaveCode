import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SandboxManager } from '../identity/sandbox';
import type { Account, TaskNode } from '../types';
import { ClaudeCliExecutor, selectClaudeAccount } from './claude-cli-executor';
import { ExecutorAbortedError, ExecutorError } from './executor';

// A stand-in for `claude`: records argv, stdin and CLAUDE_CONFIG_DIR, edits a file in cwd and
// prints stream-json events.
const FAKE = `
const fs = require('fs');
const scenario = process.argv[2];
const args = process.argv.slice(3);
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.on('end', () => {
  const calls = fs.existsSync('calls.json') ? JSON.parse(fs.readFileSync('calls.json', 'utf8')) : [];
  calls.push({ args, stdin, configDir: process.env.CLAUDE_CONFIG_DIR, cwd: process.cwd() });
  fs.writeFileSync('calls.json', JSON.stringify(calls));
  out({ type: 'system', subtype: 'init', session_id: '0f8fad5b-d9cb-469f-a165-70867728950e' });
  if (scenario === 'ok') {
    fs.writeFileSync('done.txt', 'implemented');
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: {} }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Wrote done.txt',
      session_id: '0f8fad5b-d9cb-469f-a165-70867728950e',
      usage: { input_tokens: 100, output_tokens: 20 } });
  } else if (scenario === 'error') {
    out({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'max turns' });
  } else if (scenario === 'hang') {
    setInterval(() => {}, 1000);
  }
});
`;

let dir: string;
let script: string;
let repo: string;
let sandboxes: SandboxManager;

function account(scenario: string, extra: Partial<Account> = {}): Account {
  return {
    id: 'acc_claude',
    provider: 'claude-cli',
    label: 'claude',
    enabled: true,
    priority: 0,
    weight: 1,
    limits: {},
    config: { binaryPath: process.execPath, binaryArgs: [script, scenario] },
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

const task: TaskNode = { id: 't', title: 'Do it', status: 'IN_PROGRESS', dependsOn: [] };

function executor(scenario: string, timeoutMs?: number) {
  return new ClaudeCliExecutor({
    accounts: { list: () => [account(scenario)] },
    sandboxes,
    model: 'sonnet',
    allowedTools: ['Read', 'Edit', 'Bash(pnpm:*)'],
    ...(timeoutMs ? { timeoutMs } : {}),
  });
}

const calls = () =>
  JSON.parse(readFileSync(path.join(repo, 'calls.json'), 'utf8')) as Array<{
    args: string[];
    stdin: string;
    configDir: string;
  }>;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'davecode-claude-exec-'));
  script = path.join(dir, 'fake-claude.cjs');
  writeFileSync(script, FAKE);
  repo = mkdtempSync(path.join(tmpdir(), 'davecode-claude-repo-'));
  sandboxes = new SandboxManager(path.join(dir, 'sandboxes'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe('selectClaudeAccount', () => {
  it('picks the explicit account or the best enabled claude-cli account', () => {
    const a = account('ok', { id: 'a', priority: 5 });
    const b = account('ok', { id: 'b', priority: 1 });
    const off = account('ok', { id: 'c', priority: 0, enabled: false });
    expect(selectClaudeAccount([a, b, off]).id).toBe('b');
    expect(selectClaudeAccount([a, b], 'a').id).toBe('a');
    expect(() => selectClaudeAccount([a], 'missing')).toThrow(ExecutorError);
    expect(() => selectClaudeAccount([off])).toThrow(/no enabled claude-cli account/);
  });
});

describe('ClaudeCliExecutor', () => {
  it('runs claude headlessly in the repo with the sandbox config dir and prompt on stdin', async () => {
    const session = executor('ok').createSession({ task, context: 'CTX-MARK', root: repo });
    const result = await session.run({ cycle: 0 });
    expect(result).toMatchObject({
      summary: 'Wrote done.txt',
      stopReason: 'completed',
      tokens: 120,
    });
    expect(readFileSync(path.join(repo, 'done.txt'), 'utf8')).toBe('implemented');

    const [first] = calls();
    expect(first?.configDir).toBe(sandboxes.dirFor('acc_claude'));
    expect(first?.args).toEqual(
      expect.arrayContaining(['-p', '--permission-mode', 'acceptEdits', '--model', 'sonnet']),
    );
    expect(first?.args).toContain('--allowedTools');
    expect(first?.args).toContain('Read');
    expect(first?.stdin).toContain('CTX-MARK');
    expect(first?.stdin).toContain('DAVECODE_AUTONOMOUS_ENGINE_V1');
    expect(first?.args.join(' ')).not.toContain('CTX-MARK');

    // Repair resumes the CLI session and sends only the failure report.
    await session.run({ cycle: 1, failureReport: 'lint FAILED' });
    const second = calls().at(-1);
    expect(second?.args).toEqual(
      expect.arrayContaining(['--resume', '0f8fad5b-d9cb-469f-a165-70867728950e']),
    );
    expect(second?.stdin).toContain('lint FAILED');
    expect(second?.stdin).not.toContain('CTX-MARK');
  });

  it('reports CLI errors', async () => {
    await expect(
      executor('error').createSession({ task, context: 'c', root: repo }).run({ cycle: 0 }),
    ).rejects.toThrow(/max turns/);
  });

  it('aborts and times out', async () => {
    const controller = new AbortController();
    const pending = executor('hang')
      .createSession({ task, context: 'c', root: repo })
      .run({ cycle: 0, signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    await expect(pending).rejects.toBeInstanceOf(ExecutorAbortedError);

    await expect(
      executor('hang', 1_000).createSession({ task, context: 'c', root: repo }).run({ cycle: 0 }),
    ).rejects.toThrow(/timed out/);
  });
});
