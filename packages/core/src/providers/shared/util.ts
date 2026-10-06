import { randomUUID } from 'node:crypto';
import type {
  ChatCompletionChunk,
  ChatMessage,
  FinishReason,
  ModelInfo,
  ToolCall,
  Usage,
} from '../../types';

export type JsonObject = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function newId(prefix = 'chatcmpl'): string {
  return `${prefix}-${randomUUID()}`;
}

export function makeUsage(prompt: number, completion: number): Usage {
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

/** Strip a leading `provider/` prefix the router may have left on the model id. */
export function stripProviderPrefix(model: string, provider: string): string {
  return model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Read `config[key]` as a trimmed non-empty string. */
export function configString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function configStringArray(config: Record<string, unknown>, key: string): string[] {
  const value = config[key];
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];
}

export function configHeaders(config: Record<string, unknown>): Record<string, string> {
  const value = config.defaultHeaders;
  const out: Record<string, string> = {};
  if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return out;
}

export function modelList(ids: string[], ownedBy: string): ModelInfo[] {
  const created = nowSeconds();
  return [...new Set(ids)].map((id) => ({ id, object: 'model', created, owned_by: ownedBy }));
}

export function makeChunk(
  id: string,
  model: string,
  created: number,
  delta: ChatCompletionChunk['choices'][number]['delta'],
  finish: FinishReason = null,
  usage?: Usage,
): ChatCompletionChunk {
  const out: ChatCompletionChunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  if (usage) out.usage = usage;
  return out;
}

/**
 * Build a streaming tool-call delta. OpenAI deltas carry an `index` that the shared
 * `ToolCall` type does not model, so the delta is cast to the message shape.
 */
export function toolCallDelta(
  index: number,
  parts: { id?: string; name?: string; arguments?: string },
): Pick<ChatMessage, 'tool_calls'> {
  const fn: { name?: string; arguments: string } = { arguments: parts.arguments ?? '' };
  if (parts.name !== undefined) fn.name = parts.name;
  const call: Record<string, unknown> = { index, function: fn };
  if (parts.id !== undefined) {
    call.id = parts.id;
    call.type = 'function';
  }
  return { tool_calls: [call] as unknown as ToolCall[] };
}

/** Flatten OpenAI message content into plain text (images become a placeholder). */
export function contentToText(
  content: string | Array<{ type: string; text?: string }> | null | undefined,
): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content.map((p) => (p.type === 'text' ? (p.text ?? '') : '[image omitted]')).join('\n');
}
