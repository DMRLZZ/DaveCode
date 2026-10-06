import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../types';
import { __setEncoderForTests, approximateTokens, countTextTokens, estimateTokens } from './tokens';

afterEach(() => {
  __setEncoderForTests(undefined);
});

describe('estimateTokens', () => {
  it('counts text with o200k_base', () => {
    expect(countTextTokens('')).toBe(0);
    expect(countTextTokens('hello world')).toBe(2);
    expect(estimateTokens('hello world')).toBe(2);
  });

  it('treats special-token text as plain text instead of throwing', () => {
    expect(countTextTokens('<|endoftext|>')).toBeGreaterThan(1);
  });

  it('adds per-message overhead and counts parts, names and tool calls', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      {
        role: 'user',
        name: 'dave',
        content: [
          { type: 'text', text: 'Describe this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      },
    ];
    const total = estimateTokens(messages);
    const text =
      countTextTokens('You are helpful.') +
      countTextTokens('dave') +
      countTextTokens('Describe this') +
      countTextTokens('f') +
      countTextTokens('{}');
    expect(total).toBe(3 + 3 * 4 + text + 85);
    expect(estimateTokens({ messages })).toBe(total);
  });

  it('falls back to chars/4 when the tokenizer is unavailable', () => {
    __setEncoderForTests(null);
    expect(countTextTokens('abcdefgh')).toBe(2);
    expect(approximateTokens('abcde')).toBe(2);
    expect(estimateTokens([{ role: 'user', content: 'abcd' }])).toBe(3 + 4 + 1);
  });

  it('falls back when encoding throws', () => {
    __setEncoderForTests({
      encode: () => {
        throw new Error('boom');
      },
    });
    expect(countTextTokens('abcdefgh')).toBe(2);
  });

  it('extrapolates very long texts', () => {
    const long = 'word '.repeat(50_000);
    const n = countTextTokens(long);
    expect(n).toBeGreaterThan(40_000);
    expect(n).toBeLessThan(60_000);
  });
});
