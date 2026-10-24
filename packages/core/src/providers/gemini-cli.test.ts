import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProviderError } from '../errors';
import { GEMINI_CLI_SETTINGS } from '../identity/sandbox';
import type { ChatRequest } from '../types';
import { GeminiCliProvider } from './gemini-cli';
import { collect, makeCtx, summarizeChunks } from './shared/test-helpers';

const FAKE = `
const scenario = process.argv[2];
const args = process.argv.slice(3);
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.on('end', () => {
  out({ type: 'init', session_id: 's1', model: 'gemini-2.5-pro' });
  if (scenario === 'echo') {
    const env = {
      geminiHome: process.env.GEMINI_CLI_HOME,
      home: process.env.HOME,
      apiKey: process.env.GEMINI_API_KEY,
    };
    out({ type: 'message', role: 'user', content: stdin });
    out({ type: 'message', role: 'assistant', content: JSON.stringify({ env, args, stdin }) });
    out({ type: 'result', status: 'success', stats: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } });
  } else if (scenario === 'deltas') {
    out({ type: 'message', role: 'assistant', content: 'Hello ', delta: true });
    out({ type: 'tool_use', tool_name: 'read_file' });
    out({ type: 'error', severity: 'warning', message: 'loop detected, continuing' });
    out({ type: 'message', role: 'assistant', content: 'world', delta: true });
    out({ type: 'result', status: 'success', stats: { input_tokens: 1, output_tokens: 2 } });
  } else if (scenario === 'legacy') {
    out({ response: 'from json mode', stats: { input_tokens: 3, output_tokens: 5 } });
  } else if (scenario === 'quota') {
    out({ type: 'result', status: 'error', error: { type: 'api', message: 'RESOURCE_EXHAUSTED: Quota exceeded for quota metric' } });
    process.exit(1);
  } else if (scenario === 'auth') {
    process.stderr.write('Please set an Auth method in your settings.json');
    process.exit(41);
  } else if (scenario === 'ineligible') {
    process.stderr.write('Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. UNSUPPORTED_CLIENT');
    process.exit(1);
  } else if (scenario === 'hang') {
    setInterval(() => {}, 1000);
  }
});
`;

let dir: string;
let script: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'davecode-gemini-cli-'));
  script = path.join(dir, 'fake-gemini.cjs');
  writeFileSync(script, FAKE);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const provider = new GeminiCliProvider();
const home = () => path.join(dir, 'home');

function ctx(scenario: string, signal?: AbortSignal) {
  return makeCtx(
    'gemini-cli',
    { binaryPath: process.execPath, binaryArgs: [script, scenario] },
    { sandboxDir: home(), signal },
  );
}

const req: ChatRequest = {
  model: 'gemini-cli/gemini-2.5-pro',
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

describe('GeminiCliProvider', () => {
  it('reports the eligibility rejection observed with Gemini CLI 0.65.0 as an auth failure', async () => {
    const err = await failure(provider.complete(req, ctx('ineligible')));
    expect(err.kind).toBe('auth');
    expect(err.message).toContain('client is no longer supported');
  });

  it('runs gemini headlessly with an isolated home, no API key and a stdin transcript', async () => {
    const prev = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'parent-key-must-not-leak';
    try {
      const res = await provider.complete(req, ctx('echo'));
      const seen = JSON.parse(res.choices[0]?.message.content as string) as {
        env: { geminiHome: string; home: string; apiKey: string };
        args: string[];
        stdin: string;
      };
      expect(seen.env.geminiHome).toBe(path.resolve(home()));
      expect(seen.env.home).toBe(path.resolve(home()));
      expect(seen.env.apiKey).toBe('');
      expect(seen.args).toEqual(['--output-format', 'stream-json', '-m', 'gemini-2.5-pro']);
      expect(seen.stdin).toContain('Be terse.');
      expect(seen.stdin).toContain('ping');
      expect(res.usage).toEqual({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 });
    } finally {
      if (prev === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prev;
    }
  });

  it('seeds settings that select Login with Google, without overwriting existing ones', async () => {
    const settings = path.join(home(), '.gemini', 'settings.json');
    await provider.complete(req, ctx('echo'));
    expect(existsSync(settings)).toBe(true);
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual(GEMINI_CLI_SETTINGS);
    writeFileSync(settings, '{"custom":true}');
    await provider.complete(req, ctx('echo'));
    expect(readFileSync(settings, 'utf8')).toBe('{"custom":true}');
  });

  it('streams assistant deltas, skips tool events and warnings, reports usage last', async () => {
    const chunks = await collect(provider.stream(req, ctx('deltas')));
    const s = summarizeChunks(chunks);
    expect(s.text).toBe('Hello world');
    expect(s.finish).toBe('stop');
    expect(s.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  });

  it('accepts the single-object json output of older builds and omits -m for default', async () => {
    const res = await provider.complete({ ...req, model: 'default' }, ctx('legacy'));
    expect(res.choices[0]?.message.content).toBe('from json mode');
    expect(res.usage?.total_tokens).toBe(8);
  });

  it('maps failures', async () => {
    expect((await failure(provider.complete(req, ctx('quota')))).kind).toBe('quota_exhausted');
    expect((await failure(provider.complete(req, ctx('auth')))).kind).toBe('auth');
    const bad = await failure(provider.complete({ ...req, model: 'x;rm -rf' }, ctx('echo')));
    expect(bad.kind).toBe('bad_request');
  });

  it('kills the child on abort', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const err = await failure(collect(provider.stream(req, ctx('hang', ac.signal))));
    expect(err.kind).toBe('timeout');
  });
});
