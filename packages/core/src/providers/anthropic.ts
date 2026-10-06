import { ProviderError } from '../errors';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatMessage,
  ChatRequest,
  ContentPart,
  FinishReason,
  ModelInfo,
  Provider,
  ProviderCallContext,
  ToolCall,
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
  type JsonObject,
  joinUrl,
  makeChunk,
  makeUsage,
  modelList,
  newId,
  nowSeconds,
  stripProviderPrefix,
  toolCallDelta,
} from './shared/util';

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;

type AnthropicBlock = JsonObject;
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

export interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>;
  tool_choice?: JsonObject;
  metadata?: { user_id: string };
}

// ---------------------------------------------------------------------------
// Request translation (OpenAI -> Anthropic)
// ---------------------------------------------------------------------------

function partToBlock(part: ContentPart): AnthropicBlock | undefined {
  if (part.type === 'text') return part.text ? { type: 'text', text: part.text } : undefined;
  const url = part.image_url.url;
  const data = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
  if (data) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: data[1], data: data[3] },
    };
  }
  return { type: 'image', source: { type: 'url', url } };
}

function contentBlocks(content: ChatMessage['content']): AnthropicBlock[] {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return content.flatMap((p) => {
    const block = partToBlock(p);
    return block ? [block] : [];
  });
}

function textOf(content: ChatMessage['content']): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');
}

function parseToolArguments(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return {};
  }
}

function pushMessage(
  out: AnthropicMessage[],
  role: 'user' | 'assistant',
  blocks: AnthropicBlock[],
) {
  if (blocks.length === 0) return;
  const last = out[out.length - 1];
  if (last && last.role === role) last.content.push(...blocks);
  else out.push({ role, content: [...blocks] });
}

/** Convert an OpenAI-shaped chat request into an Anthropic Messages request. */
export function toAnthropicRequest(req: ChatRequest, model: string): AnthropicRequestBody {
  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];
  for (const m of req.messages) {
    if (m.role === 'system') {
      const text = textOf(m.content);
      if (text) systemParts.push(text);
    } else if (m.role === 'user') {
      pushMessage(messages, 'user', contentBlocks(m.content));
    } else if (m.role === 'assistant') {
      const blocks = contentBlocks(m.content);
      for (const call of m.tool_calls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: parseToolArguments(call.function.arguments),
        });
      }
      pushMessage(messages, 'assistant', blocks);
    } else {
      const text = textOf(m.content);
      pushMessage(messages, 'user', [
        {
          type: 'tool_result',
          tool_use_id: m.tool_call_id ?? '',
          content: text || '(empty)',
        },
      ]);
    }
  }
  // tool_result blocks must lead the user turn that answers a tool_use.
  for (const m of messages) {
    if (m.role === 'user') {
      m.content.sort((a, b) => Number(b.type === 'tool_result') - Number(a.type === 'tool_result'));
    }
  }

  const body: AnthropicRequestBody = {
    model,
    max_tokens: req.max_tokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages,
  };
  if (systemParts.length > 0) body.system = systemParts.join('\n\n');
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.top_p !== undefined) body.top_p = req.top_p;
  if (req.stop !== undefined) {
    const stops = (Array.isArray(req.stop) ? req.stop : [req.stop]).filter((s) => s.length > 0);
    if (stops.length > 0) body.stop_sequences = stops;
  }
  if (req.user) body.metadata = { user_id: req.user };
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      name: t.function.name,
      ...(t.function.description ? { description: t.function.description } : {}),
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));
    const choice = req.tool_choice;
    if (choice === 'auto') body.tool_choice = { type: 'auto' };
    else if (choice === 'required') body.tool_choice = { type: 'any' };
    else if (choice === 'none') body.tool_choice = { type: 'none' };
    else if (choice && typeof choice === 'object') {
      body.tool_choice = { type: 'tool', name: choice.function.name };
    }
  }
  return body;
}

// ---------------------------------------------------------------------------
// Response translation (Anthropic -> OpenAI)
// ---------------------------------------------------------------------------

export function mapStopReason(reason: unknown): FinishReason {
  switch (reason) {
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    case null:
    case undefined:
      return null;
    default:
      return 'stop';
  }
}

function toUsage(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const input =
    (asNumber(value.input_tokens) ?? 0) +
    (asNumber(value.cache_creation_input_tokens) ?? 0) +
    (asNumber(value.cache_read_input_tokens) ?? 0);
  return makeUsage(input, asNumber(value.output_tokens) ?? 0);
}

/** Convert a non-streaming Anthropic message into an OpenAI chat completion. */
export function fromAnthropicMessage(json: unknown, model: string): ChatCompletion {
  const msg = isRecord(json) ? json : {};
  let text = '';
  const toolCalls: ToolCall[] = [];
  for (const block of asArray(msg.content)) {
    if (!isRecord(block)) continue;
    if (block.type === 'text') text += asString(block.text) ?? '';
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: asString(block.id) ?? newId('call'),
        type: 'function',
        function: {
          name: asString(block.name) ?? '',
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }
  const message: ChatMessage = {
    role: 'assistant',
    content: text || (toolCalls.length ? null : ''),
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    id: asString(msg.id) ?? newId(),
    object: 'chat.completion',
    created: nowSeconds(),
    model: asString(msg.model) ?? model,
    choices: [{ index: 0, message, finish_reason: mapStopReason(msg.stop_reason) }],
    usage: toUsage(msg.usage) ?? makeUsage(0, 0),
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Anthropic Messages API adapter (API key).
 *
 * Reads `account.config`: `baseUrl` (default `https://api.anthropic.com/v1`), `defaultHeaders`
 * (e.g. `anthropic-beta`), `models` (allow-list replacing the `/models` lookup).
 */
export class AnthropicProvider implements Provider {
  readonly kind = 'anthropic' as const;

  private scope(ctx: ProviderCallContext): ErrorScope {
    return { provider: this.kind, accountId: ctx.account.id, secret: ctx.secret };
  }

  private baseUrl(ctx: ProviderCallContext): string {
    return configString(ctx.account.config, 'baseUrl') ?? ANTHROPIC_DEFAULT_BASE_URL;
  }

  private headers(ctx: ProviderCallContext): Record<string, string> {
    if (!ctx.secret) {
      throw new ProviderError('anthropic account has no API key configured', {
        kind: 'auth',
        provider: this.kind,
        accountId: ctx.account.id,
      });
    }
    return {
      'anthropic-version': ANTHROPIC_VERSION,
      ...configHeaders(ctx.account.config),
      'x-api-key': ctx.secret,
    };
  }

  async listModels(ctx: ProviderCallContext): Promise<ModelInfo[]> {
    const allow = configStringArray(ctx.account.config, 'models');
    if (allow.length > 0) return modelList(allow, this.kind);
    const json = await sendJson(
      {
        url: `${joinUrl(this.baseUrl(ctx), 'models')}?limit=1000`,
        method: 'GET',
        headers: this.headers(ctx),
        signal: ctx.signal,
      },
      this.scope(ctx),
    );
    const data = isRecord(json) ? asArray(json.data) : [];
    return modelList(
      data.flatMap((m) => (isRecord(m) && asString(m.id) ? [asString(m.id) as string] : [])),
      this.kind,
    );
  }

  async complete(req: ChatRequest, ctx: ProviderCallContext): Promise<ChatCompletion> {
    const model = stripProviderPrefix(req.model, this.kind);
    const json = await sendJson(
      {
        url: joinUrl(this.baseUrl(ctx), 'messages'),
        headers: this.headers(ctx),
        body: toAnthropicRequest(req, model),
        signal: ctx.signal,
      },
      this.scope(ctx),
    );
    return fromAnthropicMessage(json, model);
  }

  async *stream(req: ChatRequest, ctx: ProviderCallContext): AsyncGenerator<ChatCompletionChunk> {
    const model = stripProviderPrefix(req.model, this.kind);
    const scope = this.scope(ctx);
    const res = await send(
      {
        url: joinUrl(this.baseUrl(ctx), 'messages'),
        headers: this.headers(ctx),
        body: { ...toAnthropicRequest(req, model), stream: true },
        signal: ctx.signal,
      },
      scope,
    );

    let id = newId();
    let outModel = model;
    const created = nowSeconds();
    let inputTokens = 0;
    let cacheTokens = 0;
    let outputTokens = 0;
    let finish: FinishReason = null;
    let finished = false;
    let sawContent = false;
    // Anthropic content block index -> OpenAI tool_calls index.
    const toolIndex = new Map<number, number>();

    const finalChunk = (): ChatCompletionChunk =>
      makeChunk(
        id,
        outModel,
        created,
        {},
        finish ?? 'stop',
        makeUsage(inputTokens + cacheTokens, outputTokens),
      );

    try {
      for await (const event of parseSse(guardedBody(res, scope, ctx.signal))) {
        let json: unknown;
        try {
          json = JSON.parse(event.data);
        } catch {
          continue;
        }
        if (!isRecord(json)) continue;
        const type = asString(json.type) ?? event.event;

        if (type === 'message_start') {
          const message = isRecord(json.message) ? json.message : {};
          id = asString(message.id) ?? id;
          outModel = asString(message.model) ?? outModel;
          const usage = isRecord(message.usage) ? message.usage : {};
          inputTokens = asNumber(usage.input_tokens) ?? 0;
          cacheTokens =
            (asNumber(usage.cache_creation_input_tokens) ?? 0) +
            (asNumber(usage.cache_read_input_tokens) ?? 0);
          outputTokens = asNumber(usage.output_tokens) ?? 0;
          yield makeChunk(id, outModel, created, { role: 'assistant', content: '' });
        } else if (type === 'content_block_start') {
          const block = isRecord(json.content_block) ? json.content_block : {};
          if (block.type === 'tool_use') {
            const idx = toolIndex.size;
            toolIndex.set(asNumber(json.index) ?? idx, idx);
            sawContent = true;
            yield makeChunk(
              id,
              outModel,
              created,
              toolCallDelta(idx, {
                id: asString(block.id) ?? newId('call'),
                name: asString(block.name) ?? '',
                arguments: '',
              }),
            );
          }
        } else if (type === 'content_block_delta') {
          const delta = isRecord(json.delta) ? json.delta : {};
          if (delta.type === 'text_delta') {
            const text = asString(delta.text) ?? '';
            if (text) {
              sawContent = true;
              yield makeChunk(id, outModel, created, { content: text });
            }
          } else if (delta.type === 'input_json_delta') {
            const idx = toolIndex.get(asNumber(json.index) ?? -1);
            const partial = asString(delta.partial_json) ?? '';
            if (idx !== undefined && partial) {
              yield makeChunk(id, outModel, created, toolCallDelta(idx, { arguments: partial }));
            }
          }
        } else if (type === 'message_delta') {
          const delta = isRecord(json.delta) ? json.delta : {};
          const reason = mapStopReason(delta.stop_reason);
          if (reason) finish = reason;
          const usage = isRecord(json.usage) ? json.usage : {};
          const out = asNumber(usage.output_tokens);
          if (out !== undefined) outputTokens = out;
          const inp = asNumber(usage.input_tokens);
          if (inp !== undefined && inp > 0) inputTokens = inp;
        } else if (type === 'message_stop') {
          finished = true;
          yield finalChunk();
          return;
        } else if (type === 'error') {
          throw this.streamError(isRecord(json.error) ? json.error : {}, ctx);
        }
      }
      if (!finished && (sawContent || finish)) yield finalChunk();
    } catch (err) {
      throw toProviderError(err, scope, ctx.signal);
    }
  }

  private streamError(error: JsonObject, ctx: ProviderCallContext): ProviderError {
    const type = asString(error.type) ?? '';
    const message = asString(error.message) ?? 'upstream stream error';
    let kind = classifyMessage(`${type} ${message}`);
    if (!kind) {
      if (type === 'overloaded_error' || type === 'api_error') kind = 'unavailable';
      else if (type === 'rate_limit_error') kind = 'rate_limit';
      else if (type === 'authentication_error' || type === 'permission_error') kind = 'auth';
      else if (type === 'invalid_request_error') kind = 'bad_request';
      else kind = 'unknown';
    }
    return new ProviderError(`anthropic stream error (${type}): ${redact(message, ctx.secret)}`, {
      kind,
      provider: this.kind,
      accountId: ctx.account.id,
    });
  }
}
