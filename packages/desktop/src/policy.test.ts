import { describe, expect, it } from 'vitest';
import { externalUrl, readySchema, sameOrigin, startSchema } from './policy';

describe('desktop boundaries', () => {
  it('only accepts a loopback gateway without credentials or query parameters', () => {
    expect(readySchema.safeParse({ type: 'ready', url: 'http://127.0.0.1:44221' }).success).toBe(
      true,
    );
    for (const url of [
      'https://example.com',
      'http://127.0.0.1.evil:4040',
      'http://localhost:4040',
      'http://secret@127.0.0.1:4040',
      'http://127.0.0.1:4040?token=secret',
      'file:///tmp/x',
    ]) {
      expect(readySchema.safeParse({ type: 'ready', url }).success).toBe(false);
    }
  });

  it('keeps the per-launch authorization on the exact gateway origin', () => {
    const origin = 'http://127.0.0.1:44221';
    expect(sameOrigin(`${origin}/api/events`, origin)).toBe(true);
    expect(sameOrigin('http://127.0.0.1:44222/api/health', origin)).toBe(false);
    expect(sameOrigin('http://127.0.0.1.evil:44221/', origin)).toBe(false);
    expect(sameOrigin(`${origin}/api/health`, undefined)).toBe(false);
  });

  it('rejects incomplete starts and executable or credential-bearing external URLs', () => {
    expect(startSchema.safeParse({ type: 'start', project: '/tmp' }).success).toBe(false);
    expect(externalUrl('https://github.com/DMRLZZ/DaveCode')).toBe(true);
    for (const url of [
      'file:///C:/Windows/System32/cmd.exe',
      'javascript:alert(1)',
      'https://user:secret@example.com',
      'http://example.com',
      'ms-settings:',
    ]) {
      expect(externalUrl(url)).toBe(false);
    }
  });
});
