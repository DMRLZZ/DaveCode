/**
 * Executors implement one task in the repository. The runner talks to them through the
 * {@link Executor} interface; the default `builtin` strategy is DaveCode's own OpenAI
 * tool-calling loop over the {@link Router}. The opt-in `claude-cli` strategy lives in
 * `claude-cli-executor.ts`.
 */
import { DAVECODE_SYSTEM_PROMPT } from '../brain/system-prompt';
import { countTextTokens, estimateTokens } from '../rate-limiter/tokens';
import type { Router } from '../router/router';
import type { ChatMessage, LogLevel, TaskNode } from '../types';
import { truncateHead } from './process';
import { WorkspaceTools } from './tools';

export type ExecutorLogger = (level: LogLevel, message: string) => void;

export interface ExecutorTask {
  task: TaskNode;
  /** Output of `buildTaskContext` (global brain, architecture, state, task). */
  context: string;
  /** Repository root; every file operation is confined to it. */
  root: string;
  /** Progress lines (never secrets or file contents). */
  log?: ExecutorLogger;
}

export interface ExecutorRunOptions {
  /** 0 for the implementation pass, n for repair cycle n. */
  cycle: number;
  /** Failure report from the validator or judge (repair cycles). */
  failureReport?: string;
  signal?: AbortSignal;
}

export type ExecutorStopReason =
  | 'finished'
  | 'no_tool_calls'
  | 'max_iterations'
  | 'token_budget'
  | 'completed';

export interface ExecutorResult {
  /** The model's own summary of the change (used in the commit body). */
  summary: string;
  stopReason: ExecutorStopReason;
  /** Model round-trips in this pass. */
  iterations: number;
  /** Tokens used by this pass (reported or estimated). */
  tokens: number;
  /** Tokens used by the task so far, across passes. */
  totalTokens: number;
  /** Files written by tools in this session (best effort; git is the source of truth). */
  changedFiles: string[];
}

/** One task's conversation. Repair passes continue the same session. */
export interface ExecutorSession {
  run(opts: ExecutorRunOptions): Promise<ExecutorResult>;
}

export interface Executor {
  readonly name: string;
  createSession(task: ExecutorTask): ExecutorSession;
}

/** Thrown when a pass is aborted (runner stop). */
export class ExecutorAbortedError extends Error {
  constructor(message = 'executor aborted') {
    super(message);
    this.name = 'ExecutorAbortedError';
  }
}

/** Thrown when the executor cannot run at all (no account, CLI missing, upstream failure). */
export class ExecutorError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ExecutorError';
  }
}

export const TASK_INSTRUCTIONS = `You are implementing the CURRENT TASK described below in the repository that is your working directory.

Rules:
- Inspect the code before changing it. Use the tools; every path is relative to the repository root.
- Keep the change minimal and focused on the task and its acceptance criteria. Follow the existing conventions.
- Do not edit anything under .davecode/ (the runner maintains it) and do not commit, merge or switch branches: the runner owns git.
- You may run the project's checks with run_command before finishing.
- When the task is complete, call the finish tool with a concise summary of the change.`;

/** The user message that opens a task conversation. */
export function initialTaskPrompt(context: string): string {
  return `${TASK_INSTRUCTIONS}\n\n${context}`;
}

/** The user message for repair cycle `cycle`. */
export function repairPrompt(cycle: number, report: string, maxChars = 30_000): string {
  return `REPAIR CYCLE ${cycle}: the quality gates failed after your last change. Read the exact output below, diagnose the root cause, apply a targeted fix, and call finish again.\n\n${truncateHead(report.trim(), maxChars)}`;
}

/** `auto` → `davecode/auto`; anything containing `/` is used verbatim. */
export function routeModel(route: string): string {
  return route.includes('/') ? route : `davecode/${route}`;
}

export interface BuiltinExecutorOptions {
  router: Pick<Router, 'complete'>;
  /** Route (`auto`) or model id; see {@link routeModel}. */
  route: string;
  /** Round-trips per pass (default 40). */
  maxIterations?: number;
  /** Tokens per task across passes (default 1 500 000). */
  maxTaskTokens?: number;
  allowedCommands?: readonly string[];
  commandTimeoutMs?: number;
  temperature?: number;
  env?: NodeJS.ProcessEnv;
}

const KEEP_RECENT_TOOL_RESULTS = 12;
const HISTORY_SOFT_LIMIT_CHARS = 240_000;

function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

/** Elides old tool results once the conversation grows large, keeping the recent ones. */
function compactHistory(messages: ChatMessage[]): void {
  const size = messages.reduce((n, m) => n + textOf(m.content).length, 0);
  if (size <= HISTORY_SOFT_LIMIT_CHARS) return;
  const toolIndexes = messages.flatMap((m, i) => (m.role === 'tool' ? [i] : []));
  for (const i of toolIndexes.slice(0, -KEEP_RECENT_TOOL_RESULTS)) {
    const message = messages[i] as ChatMessage;
    const text = textOf(message.content);
    if (text.length > 300) {
      message.content = `${text.slice(0, 200)}\n[… older tool output elided to save context]`;
    }
  }
}

function describeCall(name: string, rawArgs: string): string {
  try {
    const args = JSON.parse(rawArgs) as Record<string, unknown>;
    if (typeof args.path === 'string') return `${name} ${args.path}`;
    if (name === 'run_command' && typeof args.command === 'string') {
      const rest = Array.isArray(args.args) ? args.args.filter((a) => typeof a === 'string') : [];
      return `${name} ${[args.command, ...rest].join(' ').slice(0, 120)}`;
    }
    if (name === 'search' && typeof args.query === 'string') {
      return `${name} ${JSON.stringify(args.query.slice(0, 60))}`;
    }
  } catch {
    // fall through
  }
  return name;
}

/** DaveCode's own tool loop over the router (OpenAI tool calling). */
export class BuiltinExecutor implements Executor {
  readonly name = 'builtin';

  constructor(private readonly options: BuiltinExecutorOptions) {}

  createSession(input: ExecutorTask): ExecutorSession {
    const opts = this.options;
    const model = routeModel(opts.route);
    const maxIterations = opts.maxIterations ?? 40;
    const maxTaskTokens = opts.maxTaskTokens ?? 1_500_000;
    const tools = new WorkspaceTools({
      root: input.root,
      ...(opts.allowedCommands ? { allowedCommands: opts.allowedCommands } : {}),
      ...(opts.commandTimeoutMs ? { commandTimeoutMs: opts.commandTimeoutMs } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    });
    const definitions = tools.definitions();
    const log: ExecutorLogger = input.log ?? (() => undefined);
    const messages: ChatMessage[] = [
      { role: 'system', content: DAVECODE_SYSTEM_PROMPT },
      { role: 'user', content: initialTaskPrompt(input.context) },
    ];
    let totalTokens = 0;

    const run = async (runOpts: ExecutorRunOptions): Promise<ExecutorResult> => {
      const { signal } = runOpts;
      if (runOpts.cycle > 0 && runOpts.failureReport) {
        messages.push({
          role: 'user',
          content: repairPrompt(runOpts.cycle, runOpts.failureReport),
        });
      }
      let iterations = 0;
      let passTokens = 0;
      let nudged = false;
      // Small models often call finish before editing anything; push back once per pass.
      const writesAtStart = tools.writeCount;
      let rejectedEmptyFinish = false;
      const result = (summary: string, stopReason: ExecutorStopReason): ExecutorResult => ({
        summary,
        stopReason,
        iterations,
        tokens: passTokens,
        totalTokens,
        changedFiles: [...tools.changedFiles],
      });

      while (iterations < maxIterations) {
        if (signal?.aborted) throw new ExecutorAbortedError();
        if (totalTokens >= maxTaskTokens) {
          log('warn', `token budget of ${maxTaskTokens} reached; stopping this pass`);
          return result('Stopped: per-task token budget reached.', 'token_budget');
        }
        compactHistory(messages);
        iterations++;
        let completion: Awaited<ReturnType<typeof opts.router.complete>>['completion'];
        try {
          ({ completion } = await opts.router.complete(
            {
              model,
              messages,
              tools: definitions,
              tool_choice: 'auto',
              ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
            },
            signal ? { signal } : {},
          ));
        } catch (err) {
          if (signal?.aborted) throw new ExecutorAbortedError();
          throw new ExecutorError(
            `model call failed: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
        const message = completion.choices[0]?.message ?? { role: 'assistant', content: '' };
        const reported = completion.usage?.total_tokens ?? 0;
        const used =
          reported > 0
            ? reported
            : estimateTokens(messages) +
              countTextTokens(
                textOf(message.content) +
                  (message.tool_calls ?? []).map((c) => c.function.arguments).join(''),
              );
        passTokens += used;
        totalTokens += used;

        const calls = message.tool_calls ?? [];
        const assistant: ChatMessage = { role: 'assistant', content: message.content ?? null };
        if (calls.length > 0) assistant.tool_calls = calls;
        messages.push(assistant);

        if (calls.length === 0) {
          const text = textOf(message.content).trim();
          if (!nudged) {
            nudged = true;
            messages.push({
              role: 'user',
              content:
                'Continue with the tools. When the task is fully implemented, call the finish tool with a summary.',
            });
            continue;
          }
          log('warn', 'model stopped calling tools without calling finish');
          return result(text || 'No summary provided.', 'no_tool_calls');
        }
        nudged = false;

        let finished: string | undefined;
        for (const call of calls) {
          if (signal?.aborted) throw new ExecutorAbortedError();
          log('debug', `tool ${describeCall(call.function.name, call.function.arguments)}`);
          const outcome = await tools.call(call.function.name, call.function.arguments, signal);
          if (!outcome.ok) {
            const reason = outcome.output.split('\n', 1)[0]?.slice(0, 200) ?? '';
            log('debug', `tool ${call.function.name} failed: ${reason}`);
          }
          if (outcome.finished) finished = outcome.finished.summary;
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: outcome.output,
          });
        }
        if (finished !== undefined) {
          if (tools.writeCount === writesAtStart && !rejectedEmptyFinish) {
            rejectedEmptyFinish = true;
            log('debug', 'finish rejected: no files were changed in this pass');
            messages.push({
              role: 'user',
              content:
                'You called finish, but no files were changed in this pass, so the task cannot be ' +
                'complete yet. Read the relevant files, change them with edit_file or write_file, ' +
                'then call finish.',
            });
            continue;
          }
          return result(finished, 'finished');
        }
      }
      log('warn', `iteration limit of ${maxIterations} reached`);
      return result('Stopped: iteration limit reached.', 'max_iterations');
    };

    return { run };
  }
}
