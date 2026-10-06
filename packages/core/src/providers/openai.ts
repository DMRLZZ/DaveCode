import { ProviderError } from '../errors';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatMessage,
  ChatRequest,
  FinishReason,
  ModelInfo,
  Provider,
  ProviderCallContext,
  ProviderKind,
  Usage,
} from '../types';
import { classifyMessage, type ErrorScope, redact, toProviderError } from './shared/errors';
import { guardedBody, send, sendJson } from './shared/http';
import { parseSse } from './shared/lines';
import {
  asArray,
  asNumber,
  asString,
  configHeaders,
  configString,
  configStringArray,
  isRecord,
  joinUrl,
  makeUsage,
  modelList,
  newId,
  nowSeconds,
  stripProviderPrefix,
} from './shared/util';

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export interface OpenAIProviderOptions {
  /** Provider kind reported by the adapter. */
  kind?: ProviderKind;
  /** Base URL used when `account.config.baseUrl` is absent. */
  defaultBaseUrl?: string;
  /** Fail with `bad_request` when no `config.baseUrl` is set. */
  requireBaseUrl?: boolean;
  /** Fail with `auth` when the context carries no secret. */
  requireSecret?: boolean;
}

const FINISH_REASONS: ReadonlySet<string> = new Set([
  'stop',
  'length',
  'tool_calls',
  'content_filter',
]);

function toFinishReason(value: unknown): FinishReason {
  if (typeof value !== 'string') return null;
  if (FINISH_REASONS.has(value)) return value as FinishReason;
  if (value === 'function_call') return 'tool_calls';
  return 'stop';
}

function parseUsage(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const prompt = asNumber(value.prompt_tokens) ?? 0;
  const completion = asNumber(value.completion_tokens) ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: asNumber(value.total_tokens) ?? prompt + completion,
  };
}

/**
 * OpenAI Chat Completions adapter. Requests and responses are already in the gateway's wire
 * format, so this is mostly a passthrough with uniform error mapping. It is also the base class
 * of the `openai-compatible` adapter.
 *
 * Reads `account.config`: `baseUrl`, `defaultHeaders`, `models` (allow-list that replaces the
 * `/models` lookup), `includeUsage` (set `false` for servers rejecting `stream_options`).
 */
export class OpenAIProvider implements Provider {
  readonly kind: ProviderKind;
  protected readonly defaultBaseUrl: string | undefined;
  protected readonly requireBaseUrl: boolean;
  protected readonly requireSecret: boolean;

  constructor(options: OpenAIProviderOptions = {}) {
    this.kind = options.kind ?? 'openai';
    this.defaultBaseUrl =
      'defaultBaseUrl' in options ? options.defaultBaseUrl : OPENAI_DEFAULT_BASE_URL;
    this.requireBaseUrl = options.requireBaseUrl ?? false;
    this.requireSecret = options.requireSecret ?? this.kind === 'openai';
  }

  protected scope(ctx: ProviderCallContext): ErrorScope {
    return { provider: this.kind, accountId: ctx.account.id, secret: ctx.secret };
  }

  protected baseUrl(ctx: ProviderCallContext): string {
    const configured = configString(ctx.account.config, 'baseUrl');
    const url = configured ?? (this.requireBaseUrl ? undefined : this.defaultBaseUrl);
    if (!url) {
      throw new ProviderError(`${this.kind} requires account.config.baseUrl`, {
        kind: 'bad_request',
        provider: this.kind,
        accountId: ctx.account.id,
      });
    }
    return url;
  }

  protected headers(ctx: ProviderCallContext): Record<string, string> {
    if (this.requireSecret && !ctx.secret) {
      throw new ProviderError(`${this.kind} account has no API key configured`, {
        kind: 'auth',
        provider: this.kind,
        accountId: ctx.account.id,
      });
    }
    return {
      ...configHeaders(ctx.account.config),
      ...(ctx.secret ? { authorization: `Bearer ${ctx.secret}` } : {}),
    };
  }

  protected modelId(model: string): string {
    return stripProviderPrefix(model, this.kind);
  }

  async listModels(ctx: ProviderCallContext): Promise<ModelInfo[]> {
    const allow = configStringArray(ctx.account.config, 'models');
    if (allow.length > 0) return modelList(allow, this.kind);
    const json = await sendJson(
      {
        url: joinUrl(this.baseUrl(ctx), 'models'),
        method: 'GET',
        headers: this.headers(ctx),
        signal: ctx.signal,
      },
      this.scope(ctx),
    );
    const data = isRecord(json) ? asArray(json.data) : [];
    const ids = data.flatMap((m) =>
      isRecord(m) && asString(m.id) ? [asString(m.id) as string] : [],
    );
    return modelList(ids, this.kind);
  }

  async complete(req: ChatRequest, ctx: ProviderCallContext): Promise<ChatCompletion> {
    const body = { ...req, model: this.modelId(req.model), stream: false };
    const json = await sendJson(
      {
        url: joinUrl(this.baseUrl(ctx), 'chat/completions'),
        headers: this.headers(ctx),
        body,
        signal: ctx.signal,
      },
      this.scope(ctx),
    );
    return this.normalizeCompletion(json, body.model, ctx);
  }

  async *stream(req: ChatRequest, ctx: ProviderCallContext): AsyncGenerator<ChatCompletionChunk> {
    const includeUsage = ctx.account.config.includeUsage !== false;
    const body = {
      ...req,
      model: this.modelId(req.model),
      stream: true,
      ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
    };
    const scope = this.scope(ctx);
    const res = await send(
      {
        url: joinUrl(this.baseUrl(ctx), 'chat/completions'),
        headers: this.headers(ctx),
        body,
        signal: ctx.signal,
      },
      scope,
    );
    try {
      for await (const event of parseSse(guardedBody(res, scope, ctx.signal))) {
        const data = event.data.trim();
        if (data === '[DONE]') return;
        let json: unknown;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (!isRecord(json)) continue;
        if (isRecord(json.error)) throw this.streamError(json.error, ctx);
        yield this.normalizeChunk(json, body.model);
      }
    } catch (err) {
      throw toProviderError(err, scope, ctx.signal);
    }
  }

  private streamError(error: Record<string, unknown>, ctx: ProviderCallContext): ProviderError {
    const message = asString(error.message) ?? 'upstream stream error';
    const code = `${asString(error.code) ?? ''} ${asString(error.type) ?? ''}`;
    return new ProviderError(`${this.kind} stream error: ${redact(message, ctx.secret)}`, {
      kind: classifyMessage(`${code} ${message}`) ?? 'unavailable',
      provider: this.kind,
      accountId: ctx.account.id,
    });
  }

  private normalizeChunk(json: Record<string, unknown>, model: string): ChatCompletionChunk {
    const choices = asArray(json.choices).flatMap((c, i) => {
      if (!isRecord(c)) return [];
      const delta = isRecord(c.delta) ? (c.delta as Partial<ChatMessage>) : {};
      return [
        {
          index: asNumber(c.index) ?? i,
          delta,
          finish_reason: toFinishReason(c.finish_reason),
        },
      ];
    });
    const out: ChatCompletionChunk = {
      id: asString(json.id) ?? newId(),
      object: 'chat.completion.chunk',
      created: asNumber(json.created) ?? nowSeconds(),
      model: asString(json.model) ?? model,
      choices,
    };
    const usage = parseUsage(json.usage);
    if (usage) out.usage = usage;
    return out;
  }

  private normalizeCompletion(
    json: unknown,
    model: string,
    ctx: ProviderCallContext,
  ): ChatCompletion {
    if (!isRecord(json) || !Array.isArray(json.choices)) {
      throw new ProviderError(`${this.kind} returned an unexpected response shape`, {
        kind: 'unknown',
        provider: this.kind,
        accountId: ctx.account.id,
      });
    }
    const choices = json.choices.flatMap((c, i) => {
      if (!isRecord(c) || !isRecord(c.message)) return [];
      const message: ChatMessage = {
        ...(c.message as unknown as ChatMessage),
        role: 'assistant',
        content: (c.message.content as ChatMessage['content']) ?? null,
      };
      return [
        { index: asNumber(c.index) ?? i, message, finish_reason: toFinishReason(c.finish_reason) },
      ];
    });
    return {
      id: asString(json.id) ?? newId(),
      object: 'chat.completion',
      created: asNumber(json.created) ?? nowSeconds(),
      model: asString(json.model) ?? model,
      choices,
      usage: parseUsage(json.usage) ?? makeUsage(0, 0),
    };
  }
}
