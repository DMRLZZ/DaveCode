/**
 * Agent chats: a conversation with one vendor CLI the user is signed in to (Claude Code, Codex,
 * Antigravity), in the project's own folder. Each message runs the agent headlessly and continues
 * its own conversation; what it edited in that turn is kept as a diff. The shared contract of
 * the service, the HTTP routes and the UI; change it only together with `docs/API.md`.
 */
import { z } from 'zod';
import {
  type AgentOutput,
  ORCHESTRATOR_ACCESS,
  ORCHESTRATOR_AGENTS,
  type OrchestratorAccess,
  type OrchestratorAgent,
  type RunTranscript,
} from '../orchestrator/contract';

export const CHAT_AGENTS = ORCHESTRATOR_AGENTS;
export type ChatAgent = OrchestratorAgent;

export const CHAT_LIMITS = {
  titleMaxLength: 80,
  messageMaxLength: 20_000,
  /** Chats kept per project, newest first. */
  sessionsKept: 50,
  /** Turns kept per chat; the oldest are dropped. */
  turnsKept: 200,
  replyMaxLength: 20_000,
  /** One turn's diff; a bigger one is cut and says so. */
  patchMaxBytes: 300_000,
  /** One headless turn. */
  turnTimeoutMs: 60 * 60_000,
} as const;

export interface ChatFileChange {
  /** Relative to the project, with forward slashes. */
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
}

export type ChatTurnStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface ChatTurn {
  /** `m1`, `m2`, … in order. */
  id: string;
  /** What the person wrote. */
  prompt: string;
  status: ChatTurnStatus;
  /** What the agents could do in this turn. */
  access: OrchestratorAccess;
  /** The agent's final reply. */
  reply?: string;
  /** Short, redacted reason for `failed`. Never a secret. */
  error?: string;
  /** Files the agent changed in this turn (git projects only). */
  files?: ChatFileChange[];
  /** The diff was longer than `patchMaxBytes` and was cut. */
  patchTruncated?: boolean;
  tokens?: number;
  startedAt: string;
  finishedAt?: string;
}

export interface ChatSession {
  id: string;
  agent: ChatAgent;
  title: string;
  /** The agent's own conversation id, to continue it on the next message. */
  agentSession?: string;
  turns: ChatTurn[];
  createdAt: string;
  updatedAt: string;
}

export const createChatSchema = z.object({
  agent: z.enum(CHAT_AGENTS),
  title: z.string().trim().min(1).max(CHAT_LIMITS.titleMaxLength).optional(),
});
export type CreateChatInput = z.infer<typeof createChatSchema>;

export const sendChatSchema = z.object({
  text: z.string().trim().min(1).max(CHAT_LIMITS.messageMaxLength),
  /** Defaults to `edit`. */
  access: z.enum(ORCHESTRATOR_ACCESS).optional(),
});
export type SendChatInput = z.infer<typeof sendChatSchema>;

export const renameChatSchema = z.object({
  title: z.string().trim().min(1).max(CHAT_LIMITS.titleMaxLength),
});

export type ChatErrorCode = 'not_found' | 'busy' | 'no_agent';

export class ChatError extends Error {
  constructor(
    readonly code: ChatErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChatError';
  }
}

export interface ChatService {
  /** Newest first. */
  list(): ChatSession[];
  get(id: string): ChatSession | undefined;
  /** Rejects with `no_agent` when the agent's CLI is not installed. */
  create(input: CreateChatInput): Promise<ChatSession>;
  /**
   * Starts a turn and returns the chat with it `running`; the agent works in the background.
   * Rejects with `not_found`, or `busy` while the chat's previous turn is still running.
   */
  send(id: string, input: SendChatInput): Promise<ChatSession>;
  /** Stops the running turn. False when nothing runs. */
  cancel(id: string): boolean;
  rename(id: string, title: string): ChatSession | undefined;
  /** Rejects with `busy` while a turn runs. False when the chat is unknown. */
  remove(id: string): boolean;
  /** What the agent printed in each turn, keyed by turn id. */
  transcript(id: string): RunTranscript | undefined;
  /** The diff of one turn, as a git patch; empty when it changed nothing. */
  patch(id: string, turnId: string): string | undefined;
  /** Stops every running turn and waits for it. */
  close(): Promise<void>;
}

export type { AgentOutput };
