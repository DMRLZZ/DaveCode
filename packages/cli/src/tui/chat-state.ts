import type { ChatMessage, ProviderKind, Usage } from '@davecode/core';

/** Pure state machine behind the chat TUI (rendering lives in ChatApp). */

export type EntryKind = 'banner' | 'user' | 'assistant' | 'info' | 'error';

export interface EntryMeta {
  accountId?: string;
  accountLabel?: string;
  provider?: string;
  model?: string;
  failovers?: number;
  tokens?: number;
  /** Token count is an estimate (the upstream sent no usage). */
  estimated?: boolean;
  latencyMs?: number;
  cancelled?: boolean;
}

export interface Entry {
  id: number;
  kind: EntryKind;
  text: string;
  meta?: EntryMeta;
}

export type Connection = 'connecting' | 'online' | 'offline';

export interface StreamingState {
  id: number;
  text: string;
  startedAt: number;
  model: string;
  accountId?: string;
  provider?: string;
  failovers?: number;
}

export interface ChatState {
  /** Finalised transcript entries (rendered once, above the live area). */
  entries: Entry[];
  /** The assistant reply being streamed, if any. */
  streaming?: StreamingState;
  /** Messages sent to the gateway on the next turn. */
  conversation: ChatMessage[];
  model: string;
  connection: Connection;
  /** Account that served the last reply. */
  lastAccount?: { id: string; label?: string; provider?: string };
  /** Failover hops of the last reply and across the session. */
  lastFailovers: number;
  totalFailovers: number;
  tokens: { prompt: number; completion: number };
  /** 5h-window utilization of the last account (undefined when unknown or unlimited). */
  quota5h?: number;
  /** Bumped by /clear so the transcript re-mounts. */
  epoch: number;
  /** Submitted inputs, oldest first, for ↑/↓ recall. */
  history: string[];
  nextId: number;
}

export type ChatAction =
  | { type: 'banner'; text: string }
  | { type: 'info'; text: string }
  | { type: 'error'; text: string }
  | { type: 'user'; text: string }
  | { type: 'stream-start'; now: number }
  | {
      type: 'stream-meta';
      accountId?: string;
      provider?: ProviderKind | string;
      failovers?: number;
      accountLabel?: string;
    }
  | { type: 'stream-delta'; text: string }
  | {
      type: 'stream-end';
      now: number;
      usage?: Usage;
      cancelled?: boolean;
      error?: string;
    }
  | { type: 'set-model'; model: string }
  | { type: 'connection'; connection: Connection }
  | { type: 'quota'; accountId: string; utilization: number | undefined }
  | { type: 'clear' };

export function initialChatState(model: string): ChatState {
  return {
    entries: [],
    conversation: [],
    model,
    connection: 'connecting',
    lastFailovers: 0,
    totalFailovers: 0,
    tokens: { prompt: 0, completion: 0 },
    epoch: 0,
    history: [],
    nextId: 1,
  };
}

/** chars/4, the same fallback the gateway uses when a provider omits usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function push(state: ChatState, kind: EntryKind, text: string, meta?: EntryMeta): ChatState {
  const entry: Entry = { id: state.nextId, kind, text };
  if (meta) entry.meta = meta;
  return { ...state, entries: [...state.entries, entry], nextId: state.nextId + 1 };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'banner':
      return push(state, 'banner', action.text);
    case 'info':
      return push(state, 'info', action.text);
    case 'error':
      return push(state, 'error', action.text);
    case 'user': {
      const next = push(state, 'user', action.text);
      const history =
        state.history[state.history.length - 1] === action.text
          ? state.history
          : [...state.history, action.text].slice(-200);
      return {
        ...next,
        history,
        conversation: [...state.conversation, { role: 'user', content: action.text }],
      };
    }
    case 'stream-start':
      return {
        ...state,
        streaming: { id: state.nextId, text: '', startedAt: action.now, model: state.model },
        nextId: state.nextId + 1,
      };
    case 'stream-meta': {
      if (!state.streaming) return state;
      const streaming = { ...state.streaming };
      if (action.accountId) streaming.accountId = action.accountId;
      if (action.provider) streaming.provider = action.provider;
      if (action.failovers !== undefined) streaming.failovers = action.failovers;
      const lastAccount = action.accountId
        ? {
            id: action.accountId,
            ...(action.accountLabel ? { label: action.accountLabel } : {}),
            ...(action.provider ? { provider: action.provider } : {}),
          }
        : state.lastAccount;
      return {
        ...state,
        streaming,
        ...(lastAccount ? { lastAccount } : {}),
        ...(action.failovers !== undefined
          ? {
              lastFailovers: action.failovers,
              totalFailovers: state.totalFailovers + action.failovers,
            }
          : {}),
      };
    }
    case 'stream-delta':
      if (!state.streaming) return state;
      return {
        ...state,
        streaming: { ...state.streaming, text: state.streaming.text + action.text },
      };
    case 'stream-end': {
      const live = state.streaming;
      if (!live) return state;
      const prompt =
        action.usage?.prompt_tokens ??
        estimateTokens(
          state.conversation
            .map((m) => (typeof m.content === 'string' ? m.content : ''))
            .join('\n'),
        );
      const completion = action.usage?.completion_tokens ?? estimateTokens(live.text);
      const meta: EntryMeta = {
        model: live.model,
        latencyMs: action.now - live.startedAt,
        tokens: prompt + completion,
        ...(action.usage ? {} : { estimated: true }),
        ...(live.accountId ? { accountId: live.accountId } : {}),
        ...(state.lastAccount?.id === live.accountId && state.lastAccount?.label
          ? { accountLabel: state.lastAccount.label }
          : {}),
        ...(live.provider ? { provider: live.provider } : {}),
        ...(live.failovers ? { failovers: live.failovers } : {}),
        ...(action.cancelled ? { cancelled: true } : {}),
      };
      let next: ChatState = { ...state };
      delete next.streaming;
      const answered = live.text.length > 0;
      if (answered || action.cancelled) next = push(next, 'assistant', live.text, meta);
      if (action.error) next = push(next, 'error', action.error);
      // Only complete exchanges stay in the conversation the model sees next time; a cancelled
      // or failed turn drops its question too, so roles keep alternating.
      if (answered && !action.cancelled && !action.error) {
        next.conversation = [...next.conversation, { role: 'assistant', content: live.text }];
      } else if (next.conversation[next.conversation.length - 1]?.role === 'user') {
        next.conversation = next.conversation.slice(0, -1);
      }
      if (answered || action.usage) {
        next.tokens = {
          prompt: state.tokens.prompt + prompt,
          completion: state.tokens.completion + completion,
        };
      }
      return next;
    }
    case 'set-model':
      return { ...state, model: action.model };
    case 'connection':
      return state.connection === action.connection
        ? state
        : { ...state, connection: action.connection };
    case 'quota': {
      if (state.lastAccount?.id !== action.accountId) return state;
      const next = { ...state };
      if (action.utilization === undefined) delete next.quota5h;
      else next.quota5h = action.utilization;
      return next;
    }
    case 'clear': {
      const next: ChatState = {
        ...state,
        entries: [],
        conversation: [],
        epoch: state.epoch + 1,
      };
      delete next.streaming;
      return next;
    }
    default:
      return state;
  }
}
