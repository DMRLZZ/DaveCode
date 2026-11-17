import { z } from 'zod';
import { ApiError } from './api';
import {
  applyOrchestratorEvent,
  EMPTY_ORCHESTRATOR_STATE,
  hydrateTranscript,
  type OrchestratorState,
  type OutputLine,
  outputLines,
} from './orchestrator';
import type {
  ApiErrorBody,
  ChatSession,
  DaveEvent,
  OrchestratorAccess,
  OrchestratorAgent,
  RunTranscript,
} from './types';

/**
 * Agent chats client: the calls under `/api/chat` and a store fed by `chat.*` events. Output is
 * kept exactly like an orchestrator task's (numbered chunks folded into lines), so the same
 * merging of live output and the saved transcript applies.
 */

export const CHAT_AGENTS: readonly OrchestratorAgent[] = ['claude', 'codex', 'agy'];

export function isChatAgent(value: string): value is OrchestratorAgent {
  return (CHAT_AGENTS as readonly string[]).includes(value);
}

const turnSchema = z.looseObject({
  id: z.string(),
  prompt: z.string(),
  status: z.enum(['running', 'done', 'failed', 'cancelled']),
  startedAt: z.string(),
});
const sessionSchema = z.looseObject({
  id: z.string(),
  agent: z.enum(['claude', 'codex', 'agy']),
  title: z.string(),
  turns: z.array(turnSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const bad = () => new ApiError(0, 'bad_response', 'Unexpected chat response.');

async function call(
  base: string,
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${base.replace(/\/+$/, '')}/api/chat${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
      },
      cache: 'no-store',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    throw new ApiError(0, 'network', `Gateway unreachable: ${(e as Error).message}`);
  }
  if (response.status === 204) return undefined;
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(response.status, 'bad_response', 'Unexpected chat response.');
  }
  if (!response.ok) {
    const error = (json as Partial<ApiErrorBody> | undefined)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? `http_${response.status}`,
      error?.message ?? `The chat request failed (${response.status}).`,
    );
  }
  return json;
}

function parseSession(json: unknown): ChatSession {
  const parsed = sessionSchema.safeParse(json);
  if (!parsed.success) throw bad();
  return parsed.data as unknown as ChatSession;
}

/** Every chat of the project, or null when this gateway has no chats (older, or remote). */
export async function listChats(base: string, token: string): Promise<ChatSession[] | null> {
  let json: unknown;
  try {
    json = await call(base, token, 'GET', '/sessions');
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
  const parsed = z.object({ sessions: z.array(sessionSchema) }).safeParse(json);
  if (!parsed.success) throw bad();
  return parsed.data.sessions as unknown as ChatSession[];
}

export const createChat = async (base: string, token: string, agent: OrchestratorAgent) =>
  parseSession(await call(base, token, 'POST', '/sessions', { agent }));

export const sendChat = async (
  base: string,
  token: string,
  id: string,
  text: string,
  access: OrchestratorAccess,
) =>
  parseSession(
    await call(base, token, 'POST', `/sessions/${encodeURIComponent(id)}/messages`, {
      text,
      access,
    }),
  );

export const renameChat = async (base: string, token: string, id: string, title: string) =>
  parseSession(await call(base, token, 'PATCH', `/sessions/${encodeURIComponent(id)}`, { title }));

export async function removeChat(base: string, token: string, id: string): Promise<void> {
  await call(base, token, 'DELETE', `/sessions/${encodeURIComponent(id)}`);
}

/** Stops the agent; a chat that already stopped is not an error for someone who wanted that. */
export async function cancelChat(base: string, token: string, id: string): Promise<void> {
  try {
    await call(base, token, 'POST', `/sessions/${encodeURIComponent(id)}/cancel`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) return;
    throw e;
  }
}

const transcriptSchema = z.object({
  output: z.record(
    z.string(),
    z.object({
      from: z.number().int().min(0),
      chunks: z.array(
        z.object({ kind: z.enum(['text', 'tool', 'status', 'error']), text: z.string() }),
      ),
    }),
  ),
});

export async function chatTranscript(
  base: string,
  token: string,
  id: string,
): Promise<RunTranscript> {
  const parsed = transcriptSchema.safeParse(
    await call(base, token, 'GET', `/sessions/${encodeURIComponent(id)}/output`),
  );
  if (!parsed.success) throw bad();
  return parsed.data.output;
}

export async function chatPatch(
  base: string,
  token: string,
  id: string,
  turn: string,
): Promise<string> {
  const json = await call(
    base,
    token,
    'GET',
    `/sessions/${encodeURIComponent(id)}/turns/${encodeURIComponent(turn)}/patch`,
  );
  const parsed = z.object({ patch: z.string() }).safeParse(json);
  if (!parsed.success) throw bad();
  return parsed.data.patch;
}

// --- State ------------------------------------------------------------------------------------

export type ChatEvent = Extract<
  DaveEvent,
  { type: 'chat.session' | 'chat.removed' | 'chat.output' }
>;

export function isChatEvent(event: DaveEvent): event is ChatEvent {
  return (
    event.type === 'chat.session' || event.type === 'chat.removed' || event.type === 'chat.output'
  );
}

export interface ChatState {
  sessions: Record<string, ChatSession>;
  /** Turn output, kept in the orchestrator's shape: chat id as the run, turn id as the task. */
  output: OrchestratorState;
}

export const EMPTY_CHAT_STATE: ChatState = { sessions: {}, output: EMPTY_ORCHESTRATOR_STATE };

export function applyChatEvent(state: ChatState, event: DaveEvent): ChatState {
  if (event.type === 'chat.session') {
    if (!event.session || typeof event.session.id !== 'string') return state;
    return { ...state, sessions: { ...state.sessions, [event.session.id]: event.session } };
  }
  if (event.type === 'chat.removed') {
    if (!(event.sessionId in state.sessions)) return state;
    const sessions = { ...state.sessions };
    delete sessions[event.sessionId];
    return { ...state, sessions };
  }
  if (event.type === 'chat.output') {
    const output = applyOrchestratorEvent(state.output, {
      type: 'orchestrator.output',
      runId: event.sessionId,
      taskId: event.turnId,
      output: event.output,
      seq: event.seq,
      ts: event.ts,
    });
    return output === state.output ? state : { ...state, output };
  }
  return state;
}

/** Chats fetched over HTTP; a newer snapshot from an event is kept. */
export function hydrateChats(state: ChatState, sessions: ChatSession[]): ChatState {
  let next = state.sessions;
  for (const session of sessions) {
    const known = next[session.id];
    if (known && known.updatedAt > session.updatedAt) continue;
    if (next === state.sessions) next = { ...state.sessions };
    next[session.id] = session;
  }
  return next === state.sessions ? state : { ...state, sessions: next };
}

/** Chats newest first: the one that changed last on top. */
export function sortedChats(state: Pick<ChatState, 'sessions'>): ChatSession[] {
  return Object.values(state.sessions).sort((a, b) =>
    a.updatedAt === b.updatedAt ? (a.id < b.id ? 1 : -1) : a.updatedAt < b.updatedAt ? 1 : -1,
  );
}

export function isChatBusy(session: Pick<ChatSession, 'turns'>): boolean {
  return session.turns.at(-1)?.status === 'running';
}

export class ChatStore {
  private state: ChatState = EMPTY_CHAT_STATE;
  private pending: ChatEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly flushMs = 100) {}

  getState = (): ChatState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  ingest(event: ChatEvent): void {
    this.pending.push(event);
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, this.flushMs);
    }
  }

  hydrate(sessions: ChatSession[]): void {
    this.flush();
    this.set(hydrateChats(this.state, sessions));
  }

  upsert(session: ChatSession): void {
    this.hydrate([session]);
  }

  remove(id: string): void {
    this.flush();
    this.set(applyChatEvent(this.state, { type: 'chat.removed', sessionId: id, ts: Date.now() }));
  }

  hydrateTranscript(id: string, transcript: RunTranscript): void {
    this.flush();
    const output = hydrateTranscript(this.state.output, id, transcript);
    if (output !== this.state.output) this.set({ ...this.state, output });
  }

  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.set(batch.reduce(applyChatEvent, this.state));
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private set(next: ChatState): void {
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

export function chatOutputLines(
  state: ChatState,
  sessionId: string,
  turnId: string,
  empty: OutputLine[] = [],
): OutputLine[] {
  return outputLines(state.output, sessionId, turnId, empty);
}
