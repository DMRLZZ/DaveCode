import type { ChatCompletionChunk, DaveEvent } from '@davecode/core';

/**
 * Server-Sent Events client parsing per the WHATWG spec: `\n`, `\r\n` and `\r` line endings
 * (even when split across chunks), comments, multi-line `data`, `event`, `id` and `retry`.
 */

export interface SSEMessage {
  /** `message` when the server sent no `event:` field. */
  event: string;
  data: string;
  /** Last event id seen on the stream, if any. */
  id?: string;
  retry?: number;
}

export class SSEParser {
  private buffer = '';
  private pendingCR = false;
  private data: string[] = [];
  private event = '';
  private lastId: string | undefined;
  private retry: number | undefined;

  /** Feed decoded text; returns the messages completed by it. */
  push(chunk: string): SSEMessage[] {
    const out: SSEMessage[] = [];
    let text = chunk;
    if (this.pendingCR && text.startsWith('\n')) text = text.slice(1);
    this.pendingCR = false;
    this.buffer += text;

    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch !== '\n' && ch !== '\r') continue;
      const line = this.buffer.slice(start, i);
      if (ch === '\r') {
        if (i + 1 < this.buffer.length) {
          if (this.buffer[i + 1] === '\n') i++;
        } else {
          // A CR at the end of the chunk may be the first half of CRLF.
          this.pendingCR = true;
        }
      }
      this.processLine(line, out);
      start = i + 1;
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  /** End of stream. An unterminated final event is discarded, as the spec requires. */
  end(): SSEMessage[] {
    this.buffer = '';
    this.data = [];
    this.event = '';
    return [];
  }

  private processLine(line: string, out: SSEMessage[]): void {
    if (line === '') {
      this.dispatch(out);
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data':
        this.data.push(value);
        break;
      case 'event':
        this.event = value;
        break;
      case 'id':
        if (!value.includes('\u0000')) this.lastId = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) this.retry = Number(value);
        break;
      default:
        break;
    }
  }

  private dispatch(out: SSEMessage[]): void {
    if (this.data.length === 0) {
      this.event = '';
      return;
    }
    const message: SSEMessage = { event: this.event || 'message', data: this.data.join('\n') };
    if (this.lastId !== undefined) message.id = this.lastId;
    if (this.retry !== undefined) message.retry = this.retry;
    out.push(message);
    this.data = [];
    this.event = '';
  }
}

/** Decode a byte stream (e.g. `fetch().body`) into SSE messages. */
export async function* readSSE(
  body: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<SSEMessage> {
  const parser = new SSEParser();
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    yield* parser.push(text);
  }
  const tail = decoder.decode();
  if (tail) yield* parser.push(tail);
  yield* parser.end();
}

/** An error frame (`data: {"error": …}`) sent by the gateway after a stream started. */
export class ChatStreamError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code?: string | null) {
    super(message);
    this.name = 'ChatStreamError';
    this.code = code ?? undefined;
  }
}

/** OpenAI-style completion chunks from SSE messages, until `data: [DONE]`. */
export async function* chatChunks(
  messages: AsyncIterable<SSEMessage>,
): AsyncGenerator<ChatCompletionChunk> {
  for await (const message of messages) {
    if (message.data === '[DONE]') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.data);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const record = parsed as {
      error?: { message?: string; code?: string | null };
      choices?: unknown;
    };
    if (record.error && !record.choices) {
      throw new ChatStreamError(record.error.message ?? 'Upstream error', record.error.code);
    }
    if (Array.isArray(record.choices)) yield parsed as ChatCompletionChunk;
  }
}

/** Typed DaveCode events from `/api/events`. Malformed frames are skipped. */
export async function* daveEvents(messages: AsyncIterable<SSEMessage>): AsyncGenerator<DaveEvent> {
  for await (const message of messages) {
    try {
      const event = JSON.parse(message.data) as DaveEvent;
      if (event && typeof event.type === 'string') yield event;
    } catch {
      // ignore
    }
  }
}
