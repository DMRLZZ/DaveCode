import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../errors';
import { isShellSafeArg } from './cli';
import { classifyMessage, errorFromHttp, redact, toProviderError } from './errors';
import { parseNdjson, parseSse, readLines } from './lines';

async function* chunks(...parts: string[]): AsyncGenerator<string> {
  for (const p of parts) yield p;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('line parsers', () => {
  it('splits lines across chunk boundaries and CRLF', async () => {
    const lines = await collect(readLines(chunks('ab', 'c\r\nde', 'f\n', 'last')));
    expect(lines).toEqual(['abc', 'def', 'last']);
  });

  it('parses SSE events with names, multi-line data and comments', async () => {
    const events = await collect(
      parseSse(chunks(': hi\nevent: a\ndata: 1\n\ndata: x\ndata: y\n\n', 'data: tail')),
    );
    expect(events).toEqual([
      { event: 'a', data: '1' },
      { event: undefined, data: 'x\ny' },
      { event: undefined, data: 'tail' },
    ]);
  });

  it('parses NDJSON and reports invalid lines', async () => {
    const bad: string[] = [];
    const values = await collect(
      parseNdjson(chunks('{"a":1}\nnot json\n\n{"b":', '2}\n'), (l) => bad.push(l)),
    );
    expect(values).toEqual([{ a: 1 }, { b: 2 }]);
    expect(bad).toEqual(['not json']);
  });
});

describe('error mapping', () => {
  const scope = { provider: 'openai', accountId: 'acc', secret: 'sk-supersecret' } as const;

  it('classifies 429 with retry-after as rate_limit', () => {
    const err = errorFromHttp(
      429,
      '{"error":{"message":"slow down"}}',
      new Headers({ 'retry-after': '7' }),
      scope,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(7000);
    expect(err.provider).toBe('openai');
    expect(err.accountId).toBe('acc');
  });

  it('prefers retry-after-ms', () => {
    const err = errorFromHttp(
      429,
      '',
      new Headers({ 'retry-after-ms': '250', 'retry-after': '9' }),
      scope,
    );
    expect(err.retryAfterMs).toBe(250);
  });

  it('maps quota and context messages', () => {
    expect(
      errorFromHttp(
        429,
        '{"error":{"code":"insufficient_quota","message":"x"}}',
        new Headers(),
        scope,
      ).kind,
    ).toBe('quota_exhausted');
    expect(
      errorFromHttp(
        400,
        '{"error":{"message":"This model\'s maximum context length is 8192 tokens"}}',
        new Headers(),
        scope,
      ).kind,
    ).toBe('context_length');
    expect(classifyMessage('prompt is too long: 300000 tokens')).toBe('context_length');
    expect(classifyMessage('You hit your usage limit')).toBe('quota_exhausted');
  });

  it('never leaks the secret and maps aborts', () => {
    const err = errorFromHttp(
      401,
      '{"error":{"message":"bad key sk-supersecret"}}',
      new Headers(),
      scope,
    );
    expect(err.kind).toBe('auth');
    expect(err.message).not.toContain('sk-supersecret');
    expect(redact('a sk-supersecret b', 'sk-supersecret')).toBe('a [redacted] b');
    const abort = new DOMException('aborted', 'AbortError');
    expect(toProviderError(abort, scope).kind).toBe('timeout');
    expect(toProviderError(new TypeError('fetch failed'), scope).kind).toBe('network');
  });
});

describe('isShellSafeArg', () => {
  it('accepts plain flags, model ids and paths', () => {
    const safe = [
      '-p',
      '--output-format',
      'stream-json',
      'claude-sonnet-5-5',
      'C:\\tools\\fake.js',
    ];
    for (const arg of safe) {
      expect(isShellSafeArg(arg)).toBe(true);
    }
  });

  it('rejects anything cmd.exe could interpret', () => {
    for (const arg of [
      '%USERPROFILE%',
      'a&calc',
      'x|y',
      'a b',
      '"q"',
      '!v!',
      'a^b',
      '<in',
      '>out',
    ]) {
      expect(isShellSafeArg(arg)).toBe(false);
    }
  });
});
