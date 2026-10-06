import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProviderError } from '../errors';
import type { ChatRequest } from '../types';
import { CodexCliProvider } from './codex-cli';
import { collect, makeCtx, summarizeChunks } from './shared/test-helpers';

const FAKE = `
const scenario = process.argv[2];
const args = process.argv.slice(3);
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
process.stdin.on('end', () => {
  out({ type: 'thread.started', thread_id: 't1' });
  out({ type: 'turn.started' });
  if (scenario === 'echo') {
    const text = JSON.stringify({ home: process.env.CODEX_HOME, args, stdin });
    out({ type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'ignored' } });
    out({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text } });
    out({ type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 9 } });
  } else if (scenario === 'two') {
    out({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'Hello ' } });
    out({ type: 'future.event', foo: 1 });
    out({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'world' } });
    out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } });
  } else if (scenario === 'failed') {
    out({ type: 'error', message: 'stream disconnected' });
    out({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again later, resets 3pm (UTC)" } });
    process.exit(1);
  } else if (scenario === 'login') {
    out({ type: 'turn.failed', error: { message: 'Not logged in. Run codex login' } });
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
  dir = mkdtempSync(path.join(tmpdir(), 'davecode-codex-'));
  script = path.join(dir, 'fake-codex.cjs');
  writeFileSync(script, FAKE);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const provider = new CodexCliProvider();

function ctx(scenario: string, extra: Record<string, unknown> = {}, signal?: AbortSignal) {
  return makeCtx(
    'codex-cli',
    { binaryPath: process.execPath, binaryArgs: [script, scenario], ...extra },
    { sandboxDir: path.join(dir, 'home'), signal },
  );
}

const req: ChatRequest = {
  model: 'codex-cli/gpt-5-codex',
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

describe('CodexCliProvider', () => {
  it('runs codex exec --json with CODEX_HOME and a stdin transcript', async () => {
    const res = await provider.complete(req, ctx('echo'));
    const seen = JSON.parse(res.choices[0]?.message.content as string) as {
      home: string;
      args: string[];
      stdin: string;
    };
    expect(seen.home).toBe(path.join(dir, 'home'));
    expect(seen.args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(seen.args).toEqual(
      expect.arrayContaining(['-m', 'gpt-5-codex', '--sandbox', 'read-only']),
    );
    expect(seen.args.at(-1)).toBe('-');
    expect(seen.stdin).toContain('Be terse.');
    expect(seen.stdin).toContain('ping');
    expect(res.usage).toEqual({ prompt_tokens: 20, completion_tokens: 9, total_tokens: 29 });
  });

  it('streams agent messages, ignores unknown events, and reports usage last', async () => {
    const chunks = await collect(provider.stream(req, ctx('two')));
    const s = summarizeChunks(chunks);
    expect(s.text).toBe('Hello world');
    expect(s.finish).toBe('stop');
    expect(s.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
    expect(chunks.at(-1)?.usage).toBeDefined();
  });

  it('omits -m for the default model', async () => {
    const res = await provider.complete({ ...req, model: 'default' }, ctx('echo'));
    const seen = JSON.parse(res.choices[0]?.message.content as string) as { args: string[] };
    expect(seen.args).not.toContain('-m');
  });

  it('maps failures', async () => {
    const limit = await failure(provider.complete(req, ctx('failed')));
    expect(limit.kind).toBe('quota_exhausted');
    expect(limit.retryAfterMs).toBeGreaterThan(0);
    expect((await failure(provider.complete(req, ctx('login')))).kind).toBe('auth');
    expect((await failure(provider.complete(req, ctx('crash')))).kind).toBe('unavailable');
    const missing = await failure(
      provider.complete(
        req,
        makeCtx('codex-cli', { binaryPath: path.join(dir, 'nope') }, { sandboxDir: dir }),
      ),
    );
    expect(missing.kind).toBe('unavailable');
  });

  it('kills the child on abort', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const err = await failure(collect(provider.stream(req, ctx('hang', {}, ac.signal))));
    expect(err.kind).toBe('timeout');
  });
});
