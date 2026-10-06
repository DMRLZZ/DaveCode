import { createRequire } from 'node:module';
import type { ChatMessage, ContentPart } from '../types';

/** Anything that can be counted: raw text, a message list, or a whole request. */
export type TokenInput = string | ChatMessage[] | { messages: ChatMessage[] };

interface Encoder {
  encode(
    text: string,
    allowedSpecial?: string[] | 'all',
    disallowedSpecial?: string[] | 'all',
  ): number[];
}

/** Per-message framing overhead used by OpenAI chat formats. */
const MESSAGE_OVERHEAD = 4;
/** Every reply is primed with a few tokens. */
const REPLY_PRIMING = 3;
/** Flat estimate for an image part (low-detail tile). */
const IMAGE_TOKENS = 85;
/** Texts longer than this are sampled and extrapolated to keep estimation cheap. */
const MAX_EXACT_CHARS = 100_000;

let encoder: Encoder | null | undefined;

function loadEncoder(): Encoder | null {
  if (encoder !== undefined) return encoder;
  try {
    const require = createRequire(import.meta.url);
    const lite: unknown = require('js-tiktoken/lite');
    const ranks: unknown = require('js-tiktoken/ranks/o200k_base');
    const Tiktoken = (lite as { Tiktoken?: unknown }).Tiktoken;
    if (typeof Tiktoken !== 'function') throw new Error('js-tiktoken/lite has no Tiktoken');
    const bpe = (ranks as { default?: unknown }).default ?? ranks;
    encoder = new (Tiktoken as new (ranks: unknown) => Encoder)(bpe);
  } catch {
    encoder = null;
  }
  return encoder;
}

/** Cheap fallback used when the tokenizer cannot be initialised: ~4 characters per token. */
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Count tokens in plain text with `o200k_base` (lazily initialised), or chars/4 as fallback. */
export function countTextTokens(text: string): number {
  if (text.length === 0) return 0;
  const enc = loadEncoder();
  if (!enc) return approximateTokens(text);
  try {
    if (text.length <= MAX_EXACT_CHARS) return enc.encode(text, [], []).length;
    const sample = enc.encode(text.slice(0, MAX_EXACT_CHARS), [], []).length;
    return Math.ceil((sample / MAX_EXACT_CHARS) * text.length);
  } catch {
    return approximateTokens(text);
  }
}

function contentTokens(content: string | ContentPart[] | null): number {
  if (content === null) return 0;
  if (typeof content === 'string') return countTextTokens(content);
  let total = 0;
  for (const part of content) {
    total += part.type === 'text' ? countTextTokens(part.text) : IMAGE_TOKENS;
  }
  return total;
}

/**
 * Estimate the prompt tokens of a string, message list or request. Used for quota
 * pre-checks and as a fallback when an upstream response omits `usage`.
 */
export function estimateTokens(input: TokenInput): number {
  if (typeof input === 'string') return countTextTokens(input);
  const messages = Array.isArray(input) ? input : input.messages;
  let total = REPLY_PRIMING;
  for (const message of messages) {
    total += MESSAGE_OVERHEAD + contentTokens(message.content);
    if (message.name) total += countTextTokens(message.name);
    for (const call of message.tool_calls ?? []) {
      total += countTextTokens(call.function.name) + countTextTokens(call.function.arguments);
    }
  }
  return total;
}

/** For tests: reset or replace the lazily created encoder (`null` forces the fallback). */
export function __setEncoderForTests(value: Encoder | null | undefined): void {
  encoder = value;
}
