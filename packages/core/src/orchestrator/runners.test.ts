import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isShellSafeArg } from '../providers/shared/cli';
import type { AgentOutput, AgentRunRequest, OrchestratorAgent } from './contract';
import {
  AGY_PLAN_NOTE,
  agentArgs,
  createCliAgentRunner,
  relativePaths,
  scrubSecrets,
  unwrapShell,
} from './runners';

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
      out({ type: 'system', subtype: 'init', model: 'claude-fake', session_id: 'claude-session-1' });
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
        expect(agentArgs(agent, mode, 'full', 'win32').every(isShellSafeArg)).toBe(true);
      }
    }
  });

  it('gives Claude Code its shell tools only with full access to an edit run', () => {
    expect(agentArgs('claude', 'edit')).not.toContain('--allowedTools');
    expect(agentArgs('claude', 'edit', 'edit')).not.toContain('Bash');
    const posix = agentArgs('claude', 'edit', 'full', 'linux');
    expect(posix.slice(-2)).toEqual(['--allowedTools', 'Bash']);
    expect(posix).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
    expect(agentArgs('claude', 'edit', 'full', 'win32').slice(-3)).toEqual([
      '--allowedTools',
      'Bash',
      'PowerShell',
    ]);
    // Planning never writes or runs anything, whatever the run allows.
    expect(agentArgs('claude', 'plan', 'full')).toEqual(agentArgs('claude', 'plan'));
    expect(agentArgs('claude', 'plan', 'full')).not.toContain('Bash');
  });

  it('gives Codex network access in its sandbox only with full access', () => {
    const network = 'sandbox_workspace_write.network_access=true';
    expect(agentArgs('codex', 'edit')).not.toContain(network);
    expect(agentArgs('codex', 'edit', 'full')).toContain(network);
    expect(agentArgs('codex', 'edit', 'full')).toContain('workspace-write');
    expect(agentArgs('codex', 'edit', 'full').at(-1)).toBe('-');
    expect(agentArgs('codex', 'plan', 'full')).toEqual(agentArgs('codex', 'plan'));
    expect(agentArgs('agy', 'edit', 'full')).toEqual(agentArgs('agy', 'edit'));
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
    // An edit run's reply has its worktree path taken out, so its own folder reads ".".
    expect(edit.cwd).toBe('.');
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
    expect(res).toEqual({
      ok: true,
      text: 'Done: edited src/x.ts',
      tokens: 20,
      session: 'claude-session-1',
    });
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
    // An unexplained failure may be a dropped connection; sign-in and limits are not.
    expect(error.retryable).toBe(true);

    const login = await runner('claude', 'login').run(request('claude'));
    expect(login).toMatchObject({
      ok: false,
      error: 'Claude Code is not signed in: run `claude` in a terminal and sign in',
    });

    expect(login.retryable).toBe(false);

    const limit = await runner('claude', 'limit').run(request('claude'));
    expect(limit.error).toMatch(/^Claude Code usage limit reached/);
    expect(limit.retryable).toBe(false);
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
    expect(res.retryable).toBeUndefined();
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
    expect(realpathSync.native(plan.cwd)).toBe(realpathSync.native(workdir));
    const edit = await echo('codex', 'edit');
    expect(edit.args).toContain('workspace-write');
    expect(edit.stdin).toBe('Do the thing\nwith "quotes" & %PATH% !bang');
    expect(edit.codexHome ?? null).toBe(process.env.CODEX_HOME ?? null);
  });

  it('parses items, tolerates unknown and transient error events, keeps the last message', async () => {
    const req = request('codex');
    const res = await runner('codex', 'ok').run(req);
    expect(res).toEqual({ ok: true, text: 'All done.', tokens: 120, session: 't' });
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
    // An edit run's reply has its worktree path taken out, so its own folder reads ".".
    expect(edit.cwd).toBe('.');
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
    expect([scratchParent, realpathSync.native(scratchParent)]).toContain(path.dirname(seen.cwd));
    expect(existsSync(seen.cwd)).toBe(false);
    expect(existsSync(path.join(workdir, 'scratch.txt'))).toBe(false);
    const content = (JSON.parse(seen.stdin) as { message: { content: string } }).message.content;
    expect(content.startsWith(AGY_PLAN_NOTE)).toBe(true);
    expect(content).toContain('Do the thing');
  });

  it('coalesces text deltas per step and announces each tool step once', async () => {
    const req = request('agy');
    const res = await runner('agy', 'ok').run(req);
    expect(res).toEqual({ ok: true, text: 'Hello there\nFinished.', tokens: 12, session: 'c' });
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

describe('unwrapShell', () => {
  it('shows the command, not the shell Codex started it with', () => {
    expect(
      unwrapShell(
        String.raw`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'npm test'`,
      ),
    ).toBe('npm test');
    expect(
      unwrapShell(
        String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -Command "git status"`,
      ),
    ).toBe('git status');
    expect(unwrapShell('powershell.exe -NoLogo -NoProfile -Command Get-Location')).toBe(
      'Get-Location',
    );
    expect(unwrapShell(`bash -lc "pnpm test --run"`)).toBe('pnpm test --run');
    expect(unwrapShell(`/bin/zsh -lc 'rg -n foo'`)).toBe('rg -n foo');
    expect(unwrapShell(`sh -c ls`)).toBe('ls');
  });

  it('leaves every other command as it is', () => {
    for (const command of [
      'rg -n foo',
      'npm test',
      'bash build.sh',
      'pwsh',
      '',
      'echo "-Command x"',
    ]) {
      expect(unwrapShell(command)).toBe(command);
    }
    // Only one layer of quotes is the shell's; the rest belongs to the command.
    expect(unwrapShell(`bash -lc "echo 'a b'"`)).toBe("echo 'a b'");
    expect(unwrapShell(`bash -lc ''`)).toBe(`bash -lc ''`);
  });
});

describe('relativePaths', () => {
  const posix = '/home/me/.davecode/worktrees/abc/run1/t3';

  it('turns file links into their label', () => {
    expect(
      relativePaths(
        `Created [x.test.js](file://${posix}/x.test.js) like [a.js](file:///a.js).`,
        posix,
      ),
    ).toBe('Created x.test.js like a.js.');
  });

  it('makes paths inside the worktree relative and leaves the others', () => {
    expect(relativePaths(`Edited ${posix}/src/a.ts and /etc/hosts`, posix)).toBe(
      'Edited src/a.ts and /etc/hosts',
    );
    expect(relativePaths(`cwd is ${posix}`, posix)).toBe('cwd is .');
    expect(relativePaths(`"${posix}/a b.ts"`, posix)).toBe('"a b.ts"');
    expect(relativePaths('nothing to change', posix)).toBe('nothing to change');
    // A folder that merely starts the same is another folder.
    expect(relativePaths(`${posix}0/a.ts`, posix)).toBe(`${posix}0/a.ts`);
    // And it is not found in the middle of a longer path.
    expect(relativePaths(`/private${posix}/a.ts`, posix)).toBe(`/private${posix}/a.ts`);
  });

  it('recognizes the resolved spelling of the folder as well as the given one', () => {
    // On macOS the temp folder is /var/… and resolves to /private/var/…, which contains it.
    const resolved = realpathSync.native(workdir);
    const inside = path.join(resolved, 'src', 'a.ts');
    expect(relativePaths(`Edited ${inside}`, workdir)).toBe('Edited src/a.ts');
    expect(relativePaths(`Edited ${path.join(workdir, 'b.ts')}`, workdir)).toBe('Edited b.ts');
    expect(relativePaths(`{"cwd":${JSON.stringify(resolved)}}`, workdir)).toBe('{"cwd":"."}');
  });

  it('understands a Windows worktree spelled with either slash', () => {
    const win = String.raw`C:\Users\me\.davecode\worktrees\abc\run1\t3`;
    const expected = process.platform === 'win32' ? 'see src/a.ts' : undefined;
    const backslashes = relativePaths(
      String.raw`see C:\Users\me\.davecode\worktrees\abc\run1\t3\src\a.ts`,
      win,
    );
    const slashes = relativePaths('see C:/Users/me/.davecode/worktrees/abc/run1/t3/src/a.ts', win);
    expect(backslashes).toBe('see src/a.ts');
    expect(slashes).toBe('see src/a.ts');
    if (expected) {
      expect(relativePaths('see c:/users/ME/.davecode/worktrees/abc/run1/t3/src/a.ts', win)).toBe(
        expected,
      );
    }
  });

  it('is not applied to a plan, which is parsed as it was written', async () => {
    const res = await runner('claude', 'echo').run(request('claude', { mode: 'plan' }));
    expect(JSON.parse(res.text).cwd).toBeTruthy();
    const edit = await runner('claude', 'echo').run(request('claude', { mode: 'edit' }));
    // The echo reply contains its own working directory: in an edit run it comes back as ".".
    expect(JSON.parse(edit.text).cwd).toBe('.');
  });
});

describe('continuing a conversation', () => {
  it('passes the conversation id each CLI takes', () => {
    expect(agentArgs('claude', 'edit', 'edit', 'linux', 'abc-123')).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--resume',
      'abc-123',
    ]);
    // The tool list stays last, so it cannot take the resume option as a tool name.
    expect(agentArgs('claude', 'edit', 'full', 'win32', 'abc-123').slice(-5)).toEqual([
      '--resume',
      'abc-123',
      '--allowedTools',
      'Bash',
      'PowerShell',
    ]);
    expect(agentArgs('codex', 'edit', 'edit', 'linux', 'abc-123').slice(-3)).toEqual([
      'resume',
      'abc-123',
      '-',
    ]);
    expect(agentArgs('agy', 'edit', 'edit', 'linux', 'abc-123').slice(-3)).toEqual([
      '--conversation',
      'abc-123',
      '--print=',
    ]);
  });

  it('ignores an id that is not a plain token', () => {
    for (const bad of ['', 'a b', '$(rm -rf)', '-x', 'a;b', '"q"', 'x'.repeat(200)]) {
      for (const agent of ['claude', 'codex', 'agy'] as const) {
        expect(agentArgs(agent, 'edit', 'edit', 'linux', bad)).toEqual(agentArgs(agent, 'edit'));
      }
    }
    for (const agent of ['claude', 'codex', 'agy'] as const) {
      expect(agentArgs(agent, 'edit', 'full', 'win32', 'abc-123').every(isShellSafeArg)).toBe(true);
    }
  });

  it('returns the conversation id the CLI reported', async () => {
    const res = await runner('agy', 'ok').run(request('agy'));
    expect(res.session).toBe('c');
  });
});
