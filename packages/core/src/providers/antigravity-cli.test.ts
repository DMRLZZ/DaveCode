import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProviderError } from '../errors';
import type { ChatRequest } from '../types';
import { AntigravityCliProvider } from './antigravity-cli';
import { collect, makeCtx, summarizeChunks } from './shared/test-helpers';

// Mirrors agy 1.4.8's headless stream-json protocol (recorded 2026-10-28).
const FAKE = `
const scenario = process.argv[2];
const args = process.argv.slice(3);
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const step = (i, state, extra) => out({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: i, state, ...extra } });
const usage = { input_tokens: 30, output_tokens: 4, thinking_tokens: 2, cache_read_tokens: 0, total_tokens: 36 };
process.stdin.on('end', () => {
  out({ event: 'init', conversation_id: 'c1', init: { cwd: process.cwd(), tools: [], permission_mode: 'default' } });
  step(0, 'DONE', { step_type: 'user_input' });
  if (scenario === 'echo') {
    const text = JSON.stringify({ args, stdin, cwd: process.cwd() });
    step(1, 'ACTIVE', { step_type: 'agent_response', text_delta: text });
    out({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: text, num_turns: 1, usage } });
  } else if (scenario === 'deltas') {
    step(1, 'ACTIVE', { step_type: 'tool', tool_name: 'view_file' });
    step(2, 'ACTIVE', { step_type: 'agent_response', text_delta: 'Hello ' });
    out({ event: 'future_event' });
    step(2, 'DONE', { step_type: 'agent_response', text_delta: 'world', usage });
    out({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'Hello world', num_turns: 1, usage } });
  } else if (scenario === 'response-only') {
    out({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'Only final', num_turns: 1, usage } });
  } else if (scenario === 'quota') {
    out({ event: 'result', result: { conversation_id: 'c1', status: 'ERROR', response: '', error: 'Quota exceeded. Try again later, resets 3pm (UTC)' } });
    process.exit(1);
  } else if (scenario === 'login') {
    out({ event: 'result', result: { conversation_id: 'c1', status: 'ERROR', response: '', error: 'Not signed in. Please sign in to continue.' } });
    process.exit(1);
  } else if (scenario === 'crash') {
    process.stderr.write('503 Service Unavailable');
    process.exit(1);
  } else if (scenario === 'hang') {
    setInterval(() => {}, 1000);
  }
});
`;

let dir: string;
let script: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'davecode-agy-'));
  script = path.join(dir, 'fake-agy.cjs');
  writeFileSync(script, FAKE);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const provider = new AntigravityCliProvider();

function ctx(scenario: string, signal?: AbortSignal) {
  return makeCtx(
    'antigravity-cli',
    { binaryPath: process.execPath, binaryArgs: [script, scenario] },
    { sandboxDir: dir, signal },
  );
}

const req: ChatRequest = {
  model: 'antigravity-cli/gemini-3.8-flash-low',
  messages: [
    { role: 'system', content: 'Be terse.' },
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

describe('AntigravityCliProvider', () => {
  it('sends the transcript as one stream-json user event on stdin, sandboxed', async () => {
    const res = await provider.complete(req, ctx('echo'));
    const seen = JSON.parse(res.choices[0]?.message.content as string) as {
      args: string[];
      stdin: string;
      cwd: string;
    };
    expect(seen.args).toEqual([
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--sandbox',
      '--disable-slash-commands',
      '--model',
      'gemini-3.8-flash-low',
      '--print=',
    ]);
    const message = JSON.parse(seen.stdin.trim()) as {
      event: string;
      message: { content: string };
    };
    expect(message.event).toBe('user');
    expect(message.message.content).toContain('Be terse.');
    expect(message.message.content).toContain('ping');
    // Headless agy may write files in its working directory: it must be the sandbox.
    // realpath: on macOS the temp dir lives under the /var -> /private/var symlink.
    expect(realpathSync(seen.cwd)).toBe(realpathSync(dir));
    expect(res.usage).toEqual({ prompt_tokens: 30, completion_tokens: 6, total_tokens: 36 });
  });

  it('streams agent text deltas, ignoring tool steps and unknown events', async () => {
    const s = summarizeChunks(await collect(provider.stream(req, ctx('deltas'))));
    expect(s.text).toBe('Hello world');
    expect(s.finish).toBe('stop');
  });

  it('falls back to the final response when nothing was streamed', async () => {
    const s = summarizeChunks(await collect(provider.stream(req, ctx('response-only'))));
    expect(s.text).toBe('Only final');
  });

  it('omits --model for the default model', async () => {
    const res = await provider.complete({ ...req, model: 'default' }, ctx('echo'));
    const seen = JSON.parse(res.choices[0]?.message.content as string) as { args: string[] };
    expect(seen.args).not.toContain('--model');
  });

  it('maps failures', async () => {
    const quota = await failure(provider.complete(req, ctx('quota')));
    expect(quota.kind).toBe('quota_exhausted');
    expect((await failure(provider.complete(req, ctx('login')))).kind).toBe('auth');
    expect((await failure(provider.complete(req, ctx('crash')))).kind).toBe('unavailable');
    const bad = await failure(provider.complete({ ...req, model: 'x; rm -rf /' }, ctx('echo')));
    expect(bad.kind).toBe('bad_request');
  });

  it('kills the child on abort', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const err = await failure(collect(provider.stream(req, ctx('hang', ac.signal))));
    expect(err.kind).toBe('timeout');
  });
});
