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

export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiContent {
  role: 'user' | 'model';
  parts: JsonObject[];
}

export interface GeminiRequestBody {
  contents: GeminiContent[];
  systemInstruction?: { parts: JsonObject[] };
  generationConfig?: JsonObject;
  tools?: Array<{ functionDeclarations: JsonObject[] }>;
  toolConfig?: { functionCallingConfig: JsonObject };
}

// ---------------------------------------------------------------------------
// Request translation (OpenAI -> Gemini)
// ---------------------------------------------------------------------------

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

function imagePart(url: string): JsonObject {
  const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (data) return { inlineData: { mimeType: data[1], data: data[2] } };
  const ext = /\.([a-z0-9]+)(?:\?|#|$)/i.exec(url)?.[1]?.toLowerCase() ?? '';
  return { fileData: { mimeType: MIME_BY_EXT[ext] ?? 'image/jpeg', fileUri: url } };
}

function toParts(content: ChatMessage['content']): JsonObject[] {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  return content.flatMap((p: ContentPart) => {
    if (p.type === 'text') return p.text ? [{ text: p.text }] : [];
    return [imagePart(p.image_url.url)];
  });
}

function textOf(content: ChatMessage['content']): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');
}

function parseArgs(raw: string): JsonObject {
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return {};
  }
}

/** Gemini accepts an OpenAPI subset: drop keys it rejects. */
function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (!isRecord(schema)) return schema;
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === '$schema' || k === 'additionalProperties' || k === '$id' || k === 'definitions')
      continue;
    out[k] = sanitizeSchema(v);
  }
  return out;
}

function pushContent(out: GeminiContent[], role: 'user' | 'model', parts: JsonObject[]) {
  if (parts.length === 0) return;
  const last = out[out.length - 1];
  if (last && last.role === role) last.parts.push(...parts);
  else out.push({ role, parts: [...parts] });
}

export function toGeminiRequest(req: ChatRequest): GeminiRequestBody {
  const system: string[] = [];
  const contents: GeminiContent[] = [];
  const toolNames = new Map<string, string>();
  for (const m of req.messages) {
    if (m.role === 'system') {
      const text = textOf(m.content);
      if (text) system.push(text);
    } else if (m.role === 'user') {
      pushContent(contents, 'user', toParts(m.content));
    } else if (m.role === 'assistant') {
      const parts = toParts(m.content);
      for (const call of m.tool_calls ?? []) {
        toolNames.set(call.id, call.function.name);
        parts.push({
          functionCall: { name: call.function.name, args: parseArgs(call.function.arguments) },
        });
      }
      pushContent(contents, 'model', parts);
    } else {
      const name = (m.tool_call_id ? toolNames.get(m.tool_call_id) : undefined) ?? m.name ?? 'tool';
      const text = textOf(m.content);
      let response: JsonObject = { result: text };
      try {
        const parsed: unknown = JSON.parse(text);
        if (isRecord(parsed)) response = parsed;
      } catch {
        // plain text result
      }
      pushContent(contents, 'user', [{ functionResponse: { name, response } }]);
    }
  }

  const body: GeminiRequestBody = { contents };
  if (system.length > 0) body.systemInstruction = { parts: [{ text: system.join('\n\n') }] };

  const gen: JsonObject = {};
  if (req.temperature !== undefined) gen.temperature = req.temperature;
  if (req.top_p !== undefined) gen.topP = req.top_p;
  if (req.max_tokens !== undefined) gen.maxOutputTokens = req.max_tokens;
  if (req.stop !== undefined) gen.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  if (Object.keys(gen).length > 0) body.generationConfig = gen;

  if (req.tools && req.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: req.tools.map((t) => {
          const decl: JsonObject = { name: t.function.name };
          if (t.function.description) decl.description = t.function.description;
          const params = t.function.parameters;
          const hasProps =
            isRecord(params?.properties) && Object.keys(params.properties).length > 0;
          if (params && hasProps) decl.parameters = sanitizeSchema(params);
          return decl;
        }),
      },
    ];
    const choice = req.tool_choice;
    if (choice === 'auto') body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    else if (choice === 'none') body.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
    else if (choice === 'required') body.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
    else if (choice && typeof choice === 'object') {
      body.toolConfig = {
        functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.function.name] },
      };
    }
  }
  return body;
}

// ---------------------------------------------------------------------------
// Response translation (Gemini -> OpenAI)
// ---------------------------------------------------------------------------

export function mapFinishReason(reason: unknown, hasToolCalls: boolean): FinishReason {
  if (typeof reason !== 'string') return hasToolCalls ? 'tool_calls' : null;
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
    case 'LANGUAGE':
      return 'content_filter';
    default:
      return hasToolCalls ? 'tool_calls' : 'stop';
  }
}

function toUsage(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const prompt = asNumber(value.promptTokenCount) ?? 0;
  const completion =
    (asNumber(value.candidatesTokenCount) ?? 0) + (asNumber(value.thoughtsTokenCount) ?? 0);
  return makeUsage(prompt, completion);
}

interface ParsedCandidate {
  text: string;
  calls: Array<{ name: string; args: unknown }>;
  finishReason: unknown;
}

function parseCandidate(json: unknown): ParsedCandidate {
  const candidate = isRecord(json) ? asArray(json.candidates)[0] : undefined;
  const content = isRecord(candidate) && isRecord(candidate.content) ? candidate.content : {};
  let text = '';
  const calls: ParsedCandidate['calls'] = [];
  for (const part of asArray(content.parts)) {
    if (!isRecord(part)) continue;
    if (typeof part.text === 'string' && part.thought !== true) text += part.text;
    if (isRecord(part.functionCall)) {
      calls.push({
        name: asString(part.functionCall.name) ?? '',
        args: part.functionCall.args ?? {},
      });
    }
  }
  const finishReason = isRecord(candidate) ? candidate.finishReason : undefined;
  return { text, calls, finishReason };
}

function blockReason(json: unknown): string | undefined {
  const feedback = isRecord(json) ? json.promptFeedback : undefined;
  return isRecord(feedback) ? asString(feedback.blockReason) : undefined;
}

export function fromGeminiResponse(json: unknown, model: string): ChatCompletion {
  const { text, calls, finishReason } = parseCandidate(json);
  const toolCalls: ToolCall[] = calls.map((c) => ({
    id: newId('call'),
    type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.args) },
  }));
  const message: ChatMessage = {
    role: 'assistant',
    content: text || (toolCalls.length ? null : ''),
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const finish =
    blockReason(json) && !text
      ? 'content_filter'
      : mapFinishReason(finishReason, toolCalls.length > 0);
  const modelVersion = isRecord(json) ? asString(json.modelVersion) : undefined;
  const responseId = isRecord(json) ? asString(json.responseId) : undefined;
  return {
    id: responseId ? `chatcmpl-${responseId}` : newId(),
    object: 'chat.completion',
    created: nowSeconds(),
    model: modelVersion ?? model,
    choices: [{ index: 0, message, finish_reason: finish ?? 'stop' }],
    usage: toUsage(isRecord(json) ? json.usageMetadata : undefined) ?? makeUsage(0, 0),
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Google Gemini API adapter (`generateContent` / `streamGenerateContent?alt=sse`), API key sent
 * as `x-goog-api-key`.
 *
 * Reads `account.config`: `baseUrl` (default `https://generativelanguage.googleapis.com/v1beta`),
 * `defaultHeaders`, `models` (allow-list replacing the `/models` lookup).
 *
 * Limitation: image URLs that are not `data:` URLs are sent as `fileData`, which Gemini only
 * accepts for Google-hosted URIs; inline images should use data URLs.
 */
export class GeminiProvider implements Provider {
  readonly kind = 'gemini' as const;

  private scope(ctx: ProviderCallContext): ErrorScope {
    return { provider: this.kind, accountId: ctx.account.id, secret: ctx.secret };
  }

  private baseUrl(ctx: ProviderCallContext): string {
    return configString(ctx.account.config, 'baseUrl') ?? GEMINI_DEFAULT_BASE_URL;
  }

  private headers(ctx: ProviderCallContext): Record<string, string> {
    if (!ctx.secret) {
      throw new ProviderError('gemini account has no API key configured', {
        kind: 'auth',
        provider: this.kind,
        accountId: ctx.account.id,
      });
    }
    return { ...configHeaders(ctx.account.config), 'x-goog-api-key': ctx.secret };
  }

  private modelId(model: string): string {
    return stripProviderPrefix(model, this.kind).replace(/^models\//, '');
  }

  async listModels(ctx: ProviderCallContext): Promise<ModelInfo[]> {
    const allow = configStringArray(ctx.account.config, 'models');
    if (allow.length > 0) return modelList(allow, this.kind);
    const json = await sendJson(
      {
        url: `${joinUrl(this.baseUrl(ctx), 'models')}?pageSize=1000`,
        method: 'GET',
        headers: this.headers(ctx),
        signal: ctx.signal,
      },
      this.scope(ctx),
    );
    const ids = (isRecord(json) ? asArray(json.models) : []).flatMap((m) => {
      if (!isRecord(m)) return [];
      const name = asString(m.name);
      const methods = asArray(m.supportedGenerationMethods);
      if (!name || (methods.length > 0 && !methods.includes('generateContent'))) return [];
      return [name.replace(/^models\//, '')];
    });
    return modelList(ids, this.kind);
  }

  async complete(req: ChatRequest, ctx: ProviderCallContext): Promise<ChatCompletion> {
    const model = this.modelId(req.model);
    const json = await sendJson(
      {
        url: joinUrl(this.baseUrl(ctx), `models/${model}:generateContent`),
        headers: this.headers(ctx),
        body: toGeminiRequest(req),
        signal: ctx.signal,
      },
      this.scope(ctx),
    );
    return fromGeminiResponse(json, model);
  }

  async *stream(req: ChatRequest, ctx: ProviderCallContext): AsyncGenerator<ChatCompletionChunk> {
    const model = this.modelId(req.model);
    const scope = this.scope(ctx);
    const res = await send(
      {
        url: `${joinUrl(this.baseUrl(ctx), `models/${model}:streamGenerateContent`)}?alt=sse`,
        headers: this.headers(ctx),
        body: toGeminiRequest(req),
        signal: ctx.signal,
      },
      scope,
    );
    const id = newId();
    const created = nowSeconds();
    let outModel = model;
    let toolCount = 0;
    let finishReason: unknown;
    let usage: Usage | undefined;
    let blocked = false;
    let started = false;
    try {
      for await (const event of parseSse(guardedBody(res, scope, ctx.signal))) {
        let json: unknown;
        try {
          json = JSON.parse(event.data);
        } catch {
          continue;
        }
        if (!isRecord(json)) continue;
        if (isRecord(json.error)) throw this.streamError(json.error, ctx);
        if (!started) {
          started = true;
          yield makeChunk(id, outModel, created, { role: 'assistant', content: '' });
        }
        outModel = asString(json.modelVersion) ?? outModel;
        const { text, calls, finishReason: fr } = parseCandidate(json);
        if (text) yield makeChunk(id, outModel, created, { content: text });
        for (const call of calls) {
          yield makeChunk(
            id,
            outModel,
            created,
            toolCallDelta(toolCount++, {
              id: newId('call'),
              name: call.name,
              arguments: JSON.stringify(call.args),
            }),
          );
        }
        if (fr !== undefined && fr !== null) finishReason = fr;
        if (blockReason(json)) blocked = true;
        usage = toUsage(json.usageMetadata) ?? usage;
      }
      if (!started) yield makeChunk(id, outModel, created, { role: 'assistant', content: '' });
      const finish =
        (blocked && finishReason === undefined ? 'content_filter' : undefined) ??
        mapFinishReason(finishReason, toolCount > 0) ??
        'stop';
      yield makeChunk(id, outModel, created, {}, finish, usage ?? makeUsage(0, 0));
    } catch (err) {
      throw toProviderError(err, scope, ctx.signal);
    }
  }

  private streamError(error: JsonObject, ctx: ProviderCallContext): ProviderError {
    const message = asString(error.message) ?? 'upstream stream error';
    const status = asString(error.status) ?? '';
    let kind = classifyMessage(`${status} ${message}`);
    if (!kind) {
      if (status === 'UNAVAILABLE' || status === 'INTERNAL') kind = 'unavailable';
      else if (status === 'DEADLINE_EXCEEDED') kind = 'timeout';
      else if (status === 'UNAUTHENTICATED' || status === 'PERMISSION_DENIED') kind = 'auth';
      else if (status === 'INVALID_ARGUMENT') kind = 'bad_request';
      else kind = 'unknown';
    }
    return new ProviderError(`gemini stream error (${status}): ${redact(message, ctx.secret)}`, {
      kind,
      provider: this.kind,
      accountId: ctx.account.id,
    });
  }
}
