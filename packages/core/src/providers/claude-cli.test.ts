import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProviderError } from '../errors';
import type { ChatRequest } from '../types';
import { ClaudeCliProvider } from './claude-cli';
import { classifyCliText, parseResetMs, renderTranscript } from './shared/cli';
import { collect, makeCtx, summarizeChunks } from './shared/test-helpers';

const FAKE = `
const scenario = process.argv[2];
const args = process.argv.slice(3);
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.on('end', () => {
  out({ type: 'system', subtype: 'hook_started' });
  out({ type: 'system', subtype: 'init', model: 'claude-fake-1' });
  const usage = { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 7 };
  if (scenario === 'echo') {
    const text = JSON.stringify({ configDir: process.env.CLAUDE_CONFIG_DIR, args, stdin });
    out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn', usage });
  } else if (scenario === 'stream') {
    const ev = (event) => out({ type: 'stream_event', event, parent_tool_use_id: null });
    ev({ type: 'message_start', message: { id: 'm2', model: 'claude-fake-1' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } });
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } });
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } });
    out({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Hello' }] } });
    out({ type: 'assistant', parent_tool_use_id: 'sub', message: { id: 'sub1', content: [{ type: 'text', text: 'IGNORED' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Hello', usage });
  } else if (scenario === 'limit') {
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|' + (Math.floor(Date.now() / 1000) + 3600) });
  } else if (scenario === 'limit5h') {
    out({ type: 'result', subtype: 'success', is_error: true, result: "5-hour limit reached \\u2219 resets 3pm" });
  } else if (scenario === 'ratelimit') {
    out({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 429 rate limit exceeded' });
  } else if (scenario === 'login') {
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key \\u00b7 Please run /login' });
  } else if (scenario === 'ctx') {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Prompt is too long' });
  } else if (scenario === 'crash') {
    process.stderr.write('upstream exploded: 503 service unavailable');
    process.exit(1);
  } else if (scenario === 'hang') {
    setInterval(() => {}, 1000);
  }
});
`;

let dir: string;
let script: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'davecode-claude-'));
  script = path.join(dir, 'fake-claude.cjs');
  writeFileSync(script, FAKE);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const provider = new ClaudeCliProvider();

function ctx(scenario: string, extra: Record<string, unknown> = {}, signal?: AbortSignal) {
  return makeCtx(
    'claude-cli',
    { binaryPath: process.execPath, binaryArgs: [script, scenario], ...extra },
    { sandboxDir: path.join(dir, 'sandbox'), signal },
  );
}

const req: ChatRequest = {
  model: 'claude-cli/sonnet',
  messages: [
    { role: 'system', content: 'You are terse.' },
    { role: 'user', content: 'ping' },
  ],
};

async function failure(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    return err as ProviderError;
  }
  throw new Error('expected rejection');
}

describe('ClaudeCliProvider', () => {
  it('spawns headlessly with isolated config dir, model, system prompt and stdin transcript', async () => {
    const res = await provider.complete(req, ctx('echo'));
    const text = res.choices[0]?.message.content as string;
    const seen = JSON.parse(text) as { configDir: string; args: string[]; stdin: string };
    expect(seen.configDir).toBe(path.join(dir, 'sandbox'));
    expect(seen.args).toEqual(
      expect.arrayContaining(['-p', '--output-format', 'stream-json', '--verbose']),
    );
    expect(seen.args.slice(seen.args.indexOf('--model'), seen.args.indexOf('--model') + 2)).toEqual(
      ['--model', 'sonnet'],
    );
    const sys = seen.args.indexOf('--append-system-prompt');
    expect(seen.args[sys + 1]).toBe('You are terse.');
    expect(seen.stdin).toBe('ping');
    expect(res.usage).toEqual({ prompt_tokens: 15, completion_tokens: 7, total_tokens: 22 });
    expect(res.model).toBe('claude-fake-1');
  });

  it('omits --model for the default model and supports --system-prompt replacement', async () => {
    const res = await provider.complete(
      { ...req, model: 'default' },
      ctx('echo', { systemPromptMode: 'replace' }),
    );
    const seen = JSON.parse(res.choices[0]?.message.content as string) as { args: string[] };
    expect(seen.args).not.toContain('--model');
    expect(seen.args).toContain('--system-prompt');
  });

  it('streams text deltas once (no duplicate from the assistant event) with final usage', async () => {
    const chunks = await collect(provider.stream(req, ctx('stream')));
    const s = summarizeChunks(chunks);
    expect(s.text).toBe('Hello');
    expect(s.finish).toBe('stop');
    expect(s.usage).toEqual({ prompt_tokens: 15, completion_tokens: 7, total_tokens: 22 });
    expect(chunks[0]?.choices[0]?.delta.role).toBe('assistant');
  });

  it('maps usage limit with epoch reset to quota_exhausted + retryAfterMs', async () => {
    const err = await failure(provider.complete(req, ctx('limit')));
    expect(err.kind).toBe('quota_exhausted');
    expect(err.retryAfterMs).toBeGreaterThan(3_000_000);
    expect(err.retryAfterMs).toBeLessThanOrEqual(3_600_000);
    expect(err.failover).toBe(true);
  });

  it('maps 5-hour limit, rate limit, login, context and crashes', async () => {
    const five = await failure(provider.complete(req, ctx('limit5h')));
    expect(five.kind).toBe('quota_exhausted');
    expect(five.retryAfterMs).toBeGreaterThan(0);
    expect(five.retryAfterMs).toBeLessThanOrEqual(24 * 3600 * 1000);
    expect((await failure(provider.complete(req, ctx('ratelimit')))).kind).toBe('rate_limit');
    expect((await failure(provider.complete(req, ctx('login')))).kind).toBe('auth');
    expect((await failure(provider.complete(req, ctx('ctx')))).kind).toBe('context_length');
    expect((await failure(provider.complete(req, ctx('crash')))).kind).toBe('unavailable');
  });

  it('reports a missing binary as unavailable', async () => {
    const err = await failure(
      provider.complete(
        req,
        makeCtx(
          'claude-cli',
          { binaryPath: path.join(dir, 'does-not-exist') },
          { sandboxDir: path.join(dir, 'sandbox') },
        ),
      ),
    );
    expect(err.kind).toBe('unavailable');
    expect(err.message).toContain('binaryPath');
  });

  it('kills the child when the signal aborts', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const started = Date.now();
    const err = await failure(collect(provider.stream(req, ctx('hang', {}, ac.signal))));
    expect(err.kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('rejects immediately when already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    expect((await failure(provider.complete(req, ctx('echo', {}, ac.signal)))).kind).toBe(
      'timeout',
    );
  });

  it('lists configured or default models', async () => {
    expect((await provider.listModels(ctx('echo'))).map((m) => m.id)).toContain('sonnet');
    expect((await provider.listModels(ctx('echo', { models: ['opus'] }))).map((m) => m.id)).toEqual(
      ['opus'],
    );
  });
});

describe('CLI helpers', () => {
  it('renders multi-turn transcripts', () => {
    const t = renderTranscript(
      [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
      false,
    );
    expect(t).toContain('[User]\na');
    expect(t).toContain('[Assistant]\nb');
    expect(t.trimEnd().endsWith('[Assistant]')).toBe(true);
  });

  it('parses reset times', () => {
    const now = Date.UTC(2026, 0, 1, 10, 0, 0);
    expect(parseResetMs('limit reached|1767262800', now)).toBe(1767262800_000 - now);
    expect(parseResetMs('resets 12pm (UTC)', now)).toBe(2 * 3600 * 1000);
    expect(parseResetMs('resets 9:30am (UTC)', now)).toBe(23.5 * 3600 * 1000);
    expect(parseResetMs('nothing here', now)).toBeUndefined();
    expect(classifyCliText('You have hit your limit. resets 3pm (UTC)', now).kind).toBe(
      'quota_exhausted',
    );
  });
});
