/**
 * Agent chats: each message runs the chat's agent headlessly in the project folder, continuing
 * the agent's own conversation, streams what it does, and keeps the diff of what it changed.
 */
import { randomBytes } from 'node:crypto';
import type { EventBus } from '../events';
import type {
  AgentOutput,
  AgentRunner,
  AgentTranscript,
  RunTranscript,
} from '../orchestrator/contract';
import { TranscriptStore } from '../orchestrator/store';
import {
  CHAT_LIMITS,
  ChatError,
  type ChatService,
  type ChatSession,
  type ChatTurn,
  type CreateChatInput,
  createChatSchema,
  type SendChatInput,
  sendChatSchema,
} from './contract';
import { changesSince, takeSnapshot } from './snapshot';
import { ChatStore } from './store';

export interface ChatServiceOptions {
  /** Absolute project root: where the agents work. */
  projectDir: string;
  home: string;
  events: EventBus;
  runner: AgentRunner;
  now?: () => Date;
  newId?: () => string;
}

const LABEL = { claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity' } as const;
const OUTPUT_MAX_LENGTH = 2000;
const ERROR_MAX_LENGTH = 300;
/** Output chunks kept per turn, like an orchestrator task. */
const TRANSCRIPT_MAX_CHUNKS = 400;

export const INTERRUPTED = 'Interrupted: DaveCode closed while the agent was working.';

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** A title from the first message: its first line, shortened. */
export function titleFrom(prompt: string): string {
  const line = prompt.trim().split('\n')[0] ?? '';
  return clip(line.replace(/\s+/g, ' '), 60) || 'New chat';
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

export function createChatService(options: ChatServiceOptions): ChatService {
  return new ChatEngine(options);
}

class ChatEngine implements ChatService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly store: ChatStore;
  private readonly transcripts: TranscriptStore;
  private sessions: ChatSession[];
  private readonly running = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private readonly outputs = new Map<string, RunTranscript>();
  private readonly unsaved = new Set<string>();

  constructor(private readonly options: ChatServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomBytes(6).toString('hex'));
    this.store = new ChatStore(options.home, options.projectDir);
    this.transcripts = new TranscriptStore(options.home, options.projectDir, this.store.dir);
    this.sessions = this.store.load();
    this.recoverInterrupted();
    this.prune();
  }

  list(): ChatSession[] {
    return this.sessions.map((s) => structuredClone(s));
  }

  get(id: string): ChatSession | undefined {
    const session = this.find(id);
    return session ? structuredClone(session) : undefined;
  }

  async create(raw: CreateChatInput): Promise<ChatSession> {
    const input = createChatSchema.parse(raw);
    const available = await this.options.runner.availability();
    if (!available.some((a) => a.agent === input.agent && a.available)) {
      throw new ChatError('no_agent', `${LABEL[input.agent]} is not installed.`);
    }
    const stamp = this.stamp();
    const session: ChatSession = {
      id: this.newId(),
      agent: input.agent,
      title: input.title ?? 'New chat',
      turns: [],
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.sessions.unshift(session);
    if (this.sessions.length > CHAT_LIMITS.sessionsKept) {
      this.sessions = this.sessions.filter(
        (s, i) => i < CHAT_LIMITS.sessionsKept || this.running.has(s.id),
      );
      this.prune();
    }
    this.changed(session);
    return structuredClone(session);
  }

  async send(id: string, raw: SendChatInput): Promise<ChatSession> {
    const input = sendChatSchema.parse(raw);
    const session = this.find(id);
    if (!session) throw new ChatError('not_found', `No chat ${id}.`);
    if (this.running.has(id)) {
      throw new ChatError('busy', 'The agent is still answering the last message.');
    }
    const last = session.turns.at(-1);
    const number = last ? Number.parseInt(last.id.slice(1), 10) + 1 : 1;
    const turn: ChatTurn = {
      id: `m${Number.isFinite(number) ? number : session.turns.length + 1}`,
      prompt: input.text,
      status: 'running',
      access: input.access ?? 'edit',
      startedAt: this.stamp(),
    };
    if (session.turns.length === 0 && session.title === 'New chat') {
      session.title = titleFrom(input.text);
    }
    session.turns.push(turn);
    if (session.turns.length > CHAT_LIMITS.turnsKept) {
      session.turns.splice(0, session.turns.length - CHAT_LIMITS.turnsKept);
    }
    const controller = new AbortController();
    const entry = { controller, done: Promise.resolve() };
    this.running.set(id, entry);
    this.changed(session);
    entry.done = this.run(session, turn, controller.signal).finally(() => {
      // The next turn may already have started under the same chat: only clear this one.
      if (this.running.get(id) === entry) this.running.delete(id);
    });
    return structuredClone(session);
  }

  cancel(id: string): boolean {
    const entry = this.running.get(id);
    if (!entry) return false;
    entry.controller.abort();
    return true;
  }

  rename(id: string, title: string): ChatSession | undefined {
    const session = this.find(id);
    if (!session) return undefined;
    session.title = clip(title, CHAT_LIMITS.titleMaxLength) || session.title;
    this.changed(session);
    return structuredClone(session);
  }

  remove(id: string): boolean {
    if (this.running.has(id)) {
      throw new ChatError('busy', 'Stop the agent before deleting this chat.');
    }
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.sessions.length === before) return false;
    this.outputs.delete(id);
    void this.store.save(this.sessions);
    this.prune();
    this.options.events.emit({ type: 'chat.removed', sessionId: id, ts: this.now().getTime() });
    return true;
  }

  transcript(id: string): RunTranscript | undefined {
    if (!this.find(id)) return undefined;
    return structuredClone(this.streams(id));
  }

  patch(id: string, turnId: string): string | undefined {
    const session = this.find(id);
    if (!session?.turns.some((t) => t.id === turnId)) return undefined;
    return this.store.loadPatch(id, turnId);
  }

  async close(): Promise<void> {
    const pending = [...this.running.values()];
    for (const entry of pending) entry.controller.abort();
    await Promise.all(pending.map((entry) => entry.done));
    for (const id of this.unsaved) void this.transcripts.save(id, this.streams(id));
    this.unsaved.clear();
    await Promise.all([this.store.flush(), this.transcripts.flush()]);
  }

  // --- A turn ----------------------------------------------------------------------------------

  private async run(session: ChatSession, turn: ChatTurn, signal: AbortSignal): Promise<void> {
    const { projectDir, runner } = this.options;
    const snapshot = await takeSnapshot(projectDir).catch(() => undefined);
    try {
      // Cancelled while the tree was being recorded: the agent never starts.
      if (signal.aborted) throw signal.reason;
      const result = await runner.run({
        agent: session.agent,
        cwd: projectDir,
        prompt: turn.prompt,
        mode: 'edit',
        access: turn.access,
        ...(session.agentSession ? { resume: session.agentSession } : {}),
        signal,
        timeoutMs: CHAT_LIMITS.turnTimeoutMs,
        onOutput: (chunk) => this.output(session.id, turn.id, chunk),
      });
      if (result.session) session.agentSession = result.session;
      if (result.text.trim()) turn.reply = clip(result.text, CHAT_LIMITS.replyMaxLength);
      if (result.tokens !== undefined) turn.tokens = result.tokens;
      turn.status = result.ok ? 'done' : 'failed';
      if (!result.ok) turn.error = clip(result.error ?? 'The agent stopped.', ERROR_MAX_LENGTH);
    } catch (err) {
      turn.status = signal.aborted || isAbort(err) ? 'cancelled' : 'failed';
      if (turn.status === 'failed') {
        turn.error = clip(err instanceof Error ? err.message : String(err), ERROR_MAX_LENGTH);
      }
    }
    // A cancelled turn may still have changed files before it stopped: they are shown too.
    if (snapshot) {
      try {
        const changes = await changesSince(projectDir, snapshot, CHAT_LIMITS.patchMaxBytes);
        if (changes.files.length > 0) turn.files = changes.files;
        if (changes.truncated) turn.patchTruncated = true;
        await this.store.savePatch(session.id, turn.id, changes.patch);
      } catch {
        // The reply stands without its diff.
      }
    }
    turn.finishedAt = this.stamp();
    // Free the chat before saying the turn is over, so a reply to it is never refused as busy.
    if (this.running.get(session.id)?.controller.signal === signal) this.running.delete(session.id);
    this.changed(session);
  }

  // --- Helpers ---------------------------------------------------------------------------------

  private find(id: string): ChatSession | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  private streams(id: string): RunTranscript {
    let streams = this.outputs.get(id);
    if (!streams) {
      streams = this.transcripts.load(id) ?? {};
      this.outputs.set(id, streams);
    }
    return streams;
  }

  private recoverInterrupted(): void {
    let changed = false;
    for (const session of this.sessions) {
      for (const turn of session.turns) {
        if (turn.status !== 'running') continue;
        turn.status = 'failed';
        turn.error = INTERRUPTED;
        turn.finishedAt = this.stamp();
        changed = true;
      }
    }
    if (changed) void this.store.save(this.sessions);
  }

  private prune(): void {
    this.store.prune(new Map(this.sessions.map((s) => [s.id, new Set(s.turns.map((t) => t.id))])));
  }

  private changed(session: ChatSession): void {
    session.updatedAt = this.stamp();
    this.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    void this.store.save(this.sessions);
    if (this.unsaved.delete(session.id)) {
      void this.transcripts.save(session.id, this.streams(session.id));
    }
    this.options.events.emit({
      type: 'chat.session',
      session: structuredClone(session),
      ts: this.now().getTime(),
    });
  }

  private output(sessionId: string, turnId: string, chunk: AgentOutput): void {
    const text =
      chunk.text.length > OUTPUT_MAX_LENGTH ? chunk.text.slice(0, OUTPUT_MAX_LENGTH) : chunk.text;
    if (!text && chunk.kind !== 'error') return;
    const output: AgentOutput = { kind: chunk.kind, text };
    const streams = this.streams(sessionId);
    const stream: AgentTranscript = streams[turnId] ?? { from: 0, chunks: [] };
    streams[turnId] = stream;
    const seq = stream.from + stream.chunks.length;
    stream.chunks.push(output);
    const extra = stream.chunks.length - TRANSCRIPT_MAX_CHUNKS;
    if (extra > 0) {
      stream.chunks.splice(0, extra);
      stream.from += extra;
    }
    this.unsaved.add(sessionId);
    this.options.events.emit({
      type: 'chat.output',
      sessionId,
      turnId,
      output,
      seq,
      ts: this.now().getTime(),
    });
  }
}
