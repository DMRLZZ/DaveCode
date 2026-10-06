/** Minimal streaming line / SSE / NDJSON parsers shared by all adapters. */

export type ByteChunk = Uint8Array | string;

/** Adapt a fetch `Response.body` into an async iterable of byte chunks. */
export async function* bodyChunks(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<Uint8Array> {
  if (!body) return;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // already closed
    }
    reader.releaseLock();
  }
}

/** Split a chunk stream into lines (handles \n, \r\n and a missing trailing newline). */
export async function* readLines(chunks: AsyncIterable<ByteChunk>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      let line = buffer.slice(0, idx);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      yield line;
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) yield buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
}

export interface SseEvent {
  event?: string;
  data: string;
}

/** Parse a Server-Sent Events stream into events (comments and `id:`/`retry:` are ignored). */
export async function* parseSse(chunks: AsyncIterable<ByteChunk>): AsyncGenerator<SseEvent> {
  let event: string | undefined;
  let data: string[] = [];
  for await (const line of readLines(chunks)) {
    if (line === '') {
      if (data.length > 0) yield { event, data: data.join('\n') };
      event = undefined;
      data = [];
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length > 0) yield { event, data: data.join('\n') };
}

/** Parse newline-delimited JSON. Non-JSON lines are passed to `onInvalid` and skipped. */
export async function* parseNdjson(
  chunks: AsyncIterable<ByteChunk>,
  onInvalid?: (line: string) => void,
): AsyncGenerator<unknown> {
  for await (const line of readLines(chunks)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      onInvalid?.(trimmed);
      continue;
    }
    yield value;
  }
}
