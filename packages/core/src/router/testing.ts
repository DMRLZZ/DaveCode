/**
 * In-memory provider doubles for router and gateway tests. Not part of the runtime path.
 */
import { ProviderError, type ProviderErrorOptions } from '../errors';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatRequest,
  ModelInfo,
  Provider,
  ProviderCallContext,
  ProviderKind,
  Usage,
} from '../types';

/** A scripted outcome for one provider call. */
export type FakeResponse =
  | { type: 'complete'; content?: string; usage?: Usage }
  | { type: 'error'; error: Error }
  | {
      type: 'stream';
      chunks: string[];
      /** Throw `error` after yielding this many chunks (0 = before the first chunk). */
      failAfter?: number;
      error?: Error;
      usage?: Usage;
    };

export interface FakeCall {
  accountId: string;
  model: string;
  stream: boolean;
  secret?: string;
  sandboxDir: string;
}

export function fakeCompletion(model: string, content: string, usage?: Usage): ChatCompletion {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    created: 1_760_000_000,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export function fakeChunk(model: string, content: string, usage?: Usage): ChatCompletionChunk {
  const chunk: ChatCompletionChunk = {
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: 1_760_000_000,
    model,
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
  if (usage) chunk.usage = usage;
  return chunk;
}

/** Shorthand for a typed upstream error. */
export function providerError(
  kind: ProviderErrorOptions['kind'],
  options: Omit<ProviderErrorOptions, 'kind'> = {},
): ProviderError {
  return new ProviderError(`fake ${kind}`, { kind, ...options });
}

/**
 * Scriptable provider. Queue responses per account with {@link FakeProvider.script};
 * unscripted calls succeed with `"ok from <accountId>"`.
 */
export class FakeProvider implements Provider {
  readonly calls: FakeCall[] = [];
  private readonly scripts = new Map<string, FakeResponse[]>();

  constructor(
    readonly kind: ProviderKind,
    private readonly models: string[] = [],
  ) {}

  /** Queue responses for an account's next calls (FIFO). */
  script(accountId: string, ...responses: FakeResponse[]): this {
    const queue = this.scripts.get(accountId) ?? [];
    queue.push(...responses);
    this.scripts.set(accountId, queue);
    return this;
  }

  private next(req: ChatRequest, ctx: ProviderCallContext, stream: boolean): FakeResponse {
    const call: FakeCall = {
      accountId: ctx.account.id,
      model: req.model,
      stream,
      sandboxDir: ctx.sandboxDir,
    };
    if (ctx.secret !== undefined) call.secret = ctx.secret;
    this.calls.push(call);
    const scripted = this.scripts.get(ctx.account.id)?.shift();
    if (scripted) return scripted;
    const content = `ok from ${ctx.account.id}`;
    return stream
      ? { type: 'stream', chunks: ['ok ', 'from ', ctx.account.id] }
      : { type: 'complete', content };
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.models.map((id) => ({ id, object: 'model', created: 0, owned_by: this.kind }));
  }

  async complete(req: ChatRequest, ctx: ProviderCallContext): Promise<ChatCompletion> {
    const response = this.next(req, ctx, false);
    if (response.type === 'error') throw response.error;
    if (response.type === 'stream')
      return fakeCompletion(req.model, response.chunks.join(''), response.usage);
    return fakeCompletion(
      req.model,
      response.content ?? `ok from ${ctx.account.id}`,
      response.usage,
    );
  }

  async *stream(req: ChatRequest, ctx: ProviderCallContext): AsyncIterable<ChatCompletionChunk> {
    const response = this.next(req, ctx, true);
    if (response.type === 'error') throw response.error;
    if (response.type === 'complete') {
      yield fakeChunk(req.model, response.content ?? '', response.usage);
      return;
    }
    for (let i = 0; i < response.chunks.length; i++) {
      if (response.failAfter === i && response.error) throw response.error;
      const last = i === response.chunks.length - 1;
      yield fakeChunk(req.model, response.chunks[i]!, last ? response.usage : undefined);
    }
    if (response.failAfter === response.chunks.length && response.error) throw response.error;
  }
}
