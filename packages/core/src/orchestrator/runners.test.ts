import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isShellSafeArg } from '../providers/shared/cli';
import type { AgentOutput, AgentRunRequest, OrchestratorAgent } from './contract';
import { AGY_PLAN_NOTE, agentArgs, createCliAgentRunner, scrubSecrets } from './runners';

/** One fake CLI for all three agents: `node fake.cjs <agent> <scenario> ...realArgs`. */
const FAKE = `
const [agent, scenario, ...args] = process.argv.slice(2);
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const echo = () => JSON.stringify({
  args, stdin, cwd: process.cwd(),
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  codexHome: process.env.CODEX_HOME ?? null,
});
const hang = () => setInterval(() => {}, 1000);
const crash = (code, text) => { process.stderr.write(text); process.exit(code); };
const file = (name) => require('path').join(process.cwd(), name);

process.stdin.on('end', () => {
  if (scenario === 'hang') return hang();
  if (scenario === 'crash') return crash(2, 'boom: upstream failed, key sk-abcdefghijklmnop1234567890 rejected');
  if (scenario === 'noresult') { out({ type: 'noise' }); return; }
  if (agent === 'claude') {
    const usage = { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 5 };
    if (scenario === 'echo') return out({ type: 'result', subtype: 'success', is_error: false, result: echo(), usage });
    if (scenario === 'ok') {
      out({ type: 'system', subtype: 'init', model: 'claude-fake' });
      out({ type: 'assistant', message: { content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'Looking at the code.' },
        { type: 'tool_use', name: 'Edit', input: { file_path: file('src/x.ts'), old_string: 'a' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'pnpm test\\n  --run' } },
      ] } });
      out({ type: 'assistant', parent_tool_use_id: 'sub', message: { content: [{ type: 'text', text: 'IGNORED' }] } });
      out({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(5000) }] } });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'Done: edited src/x.ts', usage });
      return;
    }
    if (scenario === 'error') return out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Something broke' });
    if (scenario === 'login') { out({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key \\u00b7 Please run /login' }); process.exit(1); }
    if (scenario === 'limit') { out({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1999999999' }); process.exit(1); }
  }
  if (agent === 'codex') {
    if (scenario === 'echo') {
      out({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: echo() } });
      return out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    }
    if (scenario === 'ok') {
      out({ type: 'thread.started', thread_id: 't' });
      out({ type: 'turn.started' });
      out({ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'thinking' } });
      out({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'rg -n foo', status: 'in_progress' } });
      out({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'rg -n foo', exit_code: 0 } });
      out({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Working on it.' } });
      out({ type: 'error', message: 'Reconnecting... 1/5' });
      out({ type: 'item.started', item: { id: 'f1', type: 'file_change', changes: [] } });
      out({ type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: file('a.ts'), kind: 'update' }, { path: 'b.ts', kind: 'add' }] } });
      out({ type: 'item.completed', item: { id: 'w1', type: 'web_search', query: 'vitest docs' } });
      out({ type: 'some.future.event', data: 1 });
      out({ type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: 'All done.' } });
      out({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20 } });
      return;
    }
    if (scenario === 'failed') {
      out({ type: 'turn.failed', error: { message: 'stream disconnected before completion' } });
      process.exit(1);
    }
    if (scenario === 'login') return crash(1, 'Error: Not logged in. Please run codex login');
  }
  if (agent === 'agy') {
    if (scenario === 'echo') {
      return out({ event: 'result', result: { status: 'SUCCESS', response: echo(), usage: { input_tokens: 1, output_tokens: 1 } } });
    }
    if (scenario === 'write') {
      require('fs').writeFileSync(file('scratch.txt'), 'hi');
      return out({ event: 'result', result: { status: 'SUCCESS', response: echo() } });
    }
    if (scenario === 'ok') {
      const step = (o) => out({ event: 'step_update', step_update: o });
      out({ event: 'init', conversation_id: 'c', init: { cwd: process.cwd() } });
      step({ step_index: 0, state: 'DONE', step_type: 'user_input' });
      step({ step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Hel' });
      step({ step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'lo' });
      step({ step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: ' there' });
      step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'write_file', tool_info: { name: 'write_file', parameters: { Path: file('src/y.ts') } } });
      step({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'write_file', tool_info: { name: 'write_file', parameters: { Path: file('src/y.ts') } } });
      step({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Fin' });
      step({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'ished.' });
      out({ event: 'result', result: { status: 'SUCCESS', response: 'Hello there\\nFinished.', usage: { input_tokens: 7, output_tokens: 3, thinking_tokens: 2 } } });
      return;
    }
    if (scenario === 'quota') {
      return out({ event: 'result', result: { status: 'ERROR', error: 'RESOURCE_EXHAUSTED: quota exceeded' } });
    }
  }
  crash(9, 'unknown scenario ' + agent + ' ' + scenario);
});
`;

let dir: string;
let script: string;
let workdir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'davecode orchestrator runners-'));
  script = path.join(dir, 'fake-cli.cjs');
  writeFileSync(script, FAKE);
  workdir = path.join(dir, 'task worktree');
  mkdirSync(workdir, { recursive: true });
});

afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function runner(agent: OrchestratorAgent, scenario: string, scratchDir?: string) {
  return createCliAgentRunner({
    binaries: { [agent]: { command: process.execPath, args: [script, agent, scenario] } },
    scratchDir,
  });
}

function request(
  agent: OrchestratorAgent,
  extra: Partial<AgentRunRequest> = {},
): AgentRunRequest & { outputs: AgentOutput[] } {
  const outputs: AgentOutput[] = [];
  return {
    agent,
    cwd: workdir,
    prompt: 'Do the thing\nwith "quotes" & %PATH% !bang',
    mode: 'edit',
    signal: new AbortController().signal,
    timeoutMs: 60_000,
    onOutput: (c) => outputs.push(c),
    outputs,
    ...extra,
  };
}

interface Echo {
  args: string[];
  stdin: string;
  cwd: string;
  claudeConfigDir: string | null;
  codexHome: string | null;
}

async function echo(agent: OrchestratorAgent, mode: 'plan' | 'edit', scratchDir?: string) {
  const res = await runner(agent, 'echo', scratchDir).run(request(agent, { mode }));
  expect(res.ok).toBe(true);
  return JSON.parse(res.text) as Echo;
}

describe('agentArgs', () => {
  it('passes the Windows shell allow-list for every agent and mode', () => {
    for (const agent of ['claude', 'codex', 'agy'] as const) {
      for (const mode of ['plan', 'edit'] as const) {
        expect(agentArgs(agent, mode).every(isShellSafeArg)).toBe(true);
      }
    }
  });
});

describe('createCliAgentRunner: claude', () => {
  it('runs headlessly with the prompt on stdin and the global sign-in', async () => {
    const edit = await echo('claude', 'edit');
    expect(edit.args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
    ]);
    expect(edit.stdin).toBe('Do the thing\nwith "quotes" & %PATH% !bang');
    expect(edit.cwd).toBe(workdir);
    expect(edit.claudeConfigDir ?? null).toBe(process.env.CLAUDE_CONFIG_DIR ?? null);

    const plan = await echo('claude', 'plan');
    expect(plan.args).toEqual(
      expect.arrayContaining(['--permission-mode', 'plan', '--tools', '--strict-mcp-config']),
    );
    const tools = plan.args.slice(
      plan.args.indexOf('--tools') + 1,
      plan.args.indexOf('--tools') + 4,
    );
    expect(tools).toEqual(['Read', 'Glob', 'Grep']);
    expect(plan.args).not.toContain('acceptEdits');
  });

  it('reduces the stream to text and tool lines and returns the final result', async () => {
    const req = request('claude');
    const res = await runner('claude', 'ok').run(req);
    expect(res).toEqual({ ok: true, text: 'Done: edited src/x.ts', tokens: 20 });
    expect(req.outputs[0]).toEqual({ kind: 'status', text: 'Claude Code started (claude-fake)' });
    expect(req.outputs).toContainEqual({ kind: 'text', text: 'Looking at the code.' });
    expect(req.outputs).toContainEqual({ kind: 'tool', text: 'Edit src/x.ts' });
    expect(req.outputs).toContainEqual({ kind: 'tool', text: 'Bash pnpm test --run' });
    expect(req.outputs.some((o) => o.text.includes('IGNORED'))).toBe(false);
    expect(req.outputs.every((o) => o.text.length <= 2000)).toBe(true);
  });

  it('reports errors, sign-in problems and limits', async () => {
    const error = await runner('claude', 'error').run(request('claude'));
    expect(error.ok).toBe(false);
    expect(error.error).toContain('Something broke');

    const login = await runner('claude', 'login').run(request('claude'));
    expect(login).toMatchObject({
      ok: false,
      error: 'Claude Code is not signed in: run `claude` in a terminal and sign in',
    });

    const limit = await runner('claude', 'limit').run(request('claude'));
    expect(limit.error).toMatch(/^Claude Code usage limit reached/);
  });

  it('reports a crash with a redacted stderr tail, and a missing final result', async () => {
    const crash = await runner('claude', 'crash').run(request('claude'));
    expect(crash.ok).toBe(false);
    expect(crash.error).toContain('(exit 2)');
    expect(crash.error).toContain('upstream failed');
    expect(crash.error).not.toContain('sk-abcdefghijklmnop');
    expect((crash.error ?? '').length).toBeLessThanOrEqual(300);

    const none = await runner('claude', 'noresult').run(request('claude'));
    expect(none.ok).toBe(false);
    expect(none.error).toContain('without a final result');
  });

  it('reports a binary that cannot start', async () => {
    const res = await createCliAgentRunner({
      binaries: { claude: { command: path.join(dir, 'missing', 'claude-nope') } },
    }).run(request('claude'));
    expect(res.ok).toBe(false);
    expect(res.error).toContain('could not be started');
  });
});

describe('createCliAgentRunner: codex', () => {
  it('uses a read-only sandbox to plan and workspace-write to edit', async () => {
    const plan = await echo('codex', 'plan');
    expect(plan.args).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '-c',
      'approval_policy=never',
      '-',
    ]);
    expect(plan.cwd).toBe(workdir);
    const edit = await echo('codex', 'edit');
    expect(edit.args).toContain('workspace-write');
    expect(edit.stdin).toBe('Do the thing\nwith "quotes" & %PATH% !bang');
    expect(edit.codexHome ?? null).toBe(process.env.CODEX_HOME ?? null);
  });

  it('parses items, tolerates unknown and transient error events, keeps the last message', async () => {
    const req = request('codex');
    const res = await runner('codex', 'ok').run(req);
    expect(res).toEqual({ ok: true, text: 'All done.', tokens: 120 });
    const tools = req.outputs.filter((o) => o.kind === 'tool').map((o) => o.text);
    expect(tools).toEqual(['Run rg -n foo', 'Edit a.ts, b.ts', 'Search vitest docs']);
    expect(req.outputs).toContainEqual({ kind: 'text', text: 'Working on it.' });
    expect(req.outputs).toContainEqual({ kind: 'error', text: 'Reconnecting... 1/5' });
    expect(req.outputs[0]).toEqual({ kind: 'status', text: 'Codex started' });
  });

  it('reports turn failures and sign-in problems', async () => {
    const failed = await runner('codex', 'failed').run(request('codex'));
    expect(failed.ok).toBe(false);
    expect(failed.error).toBe('Codex failed (exit 1): stream disconnected before completion');
    const login = await runner('codex', 'login').run(request('codex'));
    expect(login.error).toBe('Codex is not signed in: run `codex login` in a terminal');
  });
});

describe('createCliAgentRunner: agy', () => {
  it('edits in the worktree with --sandbox and one stream-json user line', async () => {
    const edit = await echo('agy', 'edit');
    expect(edit.args).toEqual([
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--sandbox',
      '--disable-slash-commands',
      '--print=',
    ]);
    expect(edit.cwd).toBe(workdir);
    expect(JSON.parse(edit.stdin)).toEqual({
      event: 'user',
      message: { content: 'Do the thing\nwith "quotes" & %PATH% !bang' },
    });
  });

  it('plans in an empty scratch directory that is removed afterwards', async () => {
    const scratchParent = path.join(dir, 'scratch parent');
    mkdirSync(scratchParent, { recursive: true });
    const res = await runner('agy', 'write', scratchParent).run(request('agy', { mode: 'plan' }));
    expect(res.ok).toBe(true);
    const seen = JSON.parse(res.text) as Echo;
    expect(path.dirname(seen.cwd)).toBe(scratchParent);
    expect(existsSync(seen.cwd)).toBe(false);
    expect(existsSync(path.join(workdir, 'scratch.txt'))).toBe(false);
    const content = (JSON.parse(seen.stdin) as { message: { content: string } }).message.content;
    expect(content.startsWith(AGY_PLAN_NOTE)).toBe(true);
    expect(content).toContain('Do the thing');
  });

  it('coalesces text deltas per step and announces each tool step once', async () => {
    const req = request('agy');
    const res = await runner('agy', 'ok').run(req);
    expect(res).toEqual({ ok: true, text: 'Hello there\nFinished.', tokens: 12 });
    expect(req.outputs).toEqual([
      { kind: 'status', text: 'Antigravity started' },
      { kind: 'text', text: 'Hello there' },
      { kind: 'tool', text: 'write_file src/y.ts' },
      { kind: 'text', text: 'Finished.' },
    ]);
  });

  it('reports a failed result as a limit', async () => {
    const res = await runner('agy', 'quota').run(request('agy'));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^Antigravity usage limit reached: RESOURCE_EXHAUSTED/);
  });
});

describe('createCliAgentRunner: lifecycle', () => {
  it('rejects with AbortError when the request signal aborts', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const started = Date.now();
    const err = await runner('claude', 'hang')
      .run(request('claude', { signal: ac.signal }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe('AbortError');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('rejects at once when already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      runner('codex', 'echo').run(request('codex', { signal: ac.signal })),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('resolves with a timeout error when timeoutMs elapses', async () => {
    const res = await runner('agy', 'hang').run(request('agy', { timeoutMs: 300 }));
    expect(res).toMatchObject({ ok: false, error: 'Antigravity timed out after 1 s' });
  });

  it('survives an onOutput listener that throws', async () => {
    const res = await runner('agy', 'ok').run(
      request('agy', {
        onOutput: () => {
          throw new Error('listener bug');
        },
      }),
    );
    expect(res.ok).toBe(true);
  });

  it('checks availability on PATH without spawning anything', async () => {
    const bin = path.join(dir, 'bin dir');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'fakeagent'), '');
    writeFileSync(path.join(bin, 'fakeagent.cmd'), '');
    mkdirSync(path.join(bin, 'adir'), { recursive: true });
    const avail = await createCliAgentRunner({
      env: { PATH: bin, PATHEXT: '.CMD' },
      binaries: {
        claude: { command: 'fakeagent' },
        codex: { command: 'adir' },
        agy: { command: 'definitely-not-installed-xyz' },
      },
    }).availability();
    expect(avail).toEqual([
      { agent: 'claude', available: true },
      { agent: 'codex', available: false },
      { agent: 'agy', available: false },
    ]);
  });
});

describe('scrubSecrets', () => {
  it('masks credentials and collapses whitespace', () => {
    const out = scrubSecrets(
      'token=abc123def456\n Authorization: Bearer eyJhbGciOi.eyJzdWIiOiIx.sig ghp_abcdefghijklmnop AIzaSyA1234567890abcdefghijk',
    );
    expect(out).not.toMatch(/abc123def456|eyJhbGciOi|ghp_abcdefghijklmnop|AIzaSyA1234567890/);
    expect(out).not.toContain('\n');
  });
});
