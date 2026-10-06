/**
 * Opt-in `claude-cli` executor: delegates a task to the Claude Code CLI running headlessly in
 * the repository, with `CLAUDE_CONFIG_DIR` pointing at the chosen account's sandbox so the
 * login stays isolated. The prompt goes on stdin, never on the command line; on Windows `.cmd`
 * shims every argument must pass the strict shell-safe allow-list (see `providers/shared/cli`).
 */
import { DAVECODE_SYSTEM_PROMPT } from '../brain/system-prompt';
import type { SandboxManager } from '../identity/sandbox';
import {
  cliSettings,
  isShellSafeArg,
  needsShell,
  resolveOnPath,
  runCli,
} from '../providers/shared/cli';
import { redact } from '../providers/shared/errors';
import { asNumber, asString, isRecord } from '../providers/shared/util';
import type { Account } from '../types';
import {
  type Executor,
  ExecutorAbortedError,
  ExecutorError,
  type ExecutorLogger,
  type ExecutorResult,
  type ExecutorRunOptions,
  type ExecutorSession,
  type ExecutorTask,
  repairPrompt,
} from './executor';

export const CLAUDE_CLI_INSTRUCTIONS = `You are implementing the CURRENT TASK described below in the repository that is your working directory.

Rules:
- Inspect the code before changing it. Keep the change minimal and focused on the task and its acceptance criteria. Follow the existing conventions.
- Do not edit anything under .davecode/ (the runner maintains it) and do not commit, merge, push or switch branches: the runner owns git.
- You may run the project's checks before finishing.
- When the task is complete, reply with a concise summary of the change (it becomes the commit message body).`;

export interface ClaudeCliExecutorOptions {
  accounts: { list(): Account[] };
  sandboxes: Pick<SandboxManager, 'ensure'>;
  /** Account to use; defaults to the enabled `claude-cli` account with the best priority. */
  accountId?: string;
  /** `--model` alias (e.g. `sonnet`). */
  model?: string;
  /** Tools pre-approved with `--allowedTools`. */
  allowedTools: readonly string[];
  /** Hard timeout per CLI invocation (default 30 min). */
  timeoutMs?: number;
  /** Per-task token budget, checked before each invocation. */
  maxTaskTokens?: number;
}

const SAFE_MODEL = /^[\w.:[\]-]+$/;
const SAFE_SESSION = /^[A-Za-z0-9-]{8,128}$/;

/** Picks the account: explicit id, else the enabled `claude-cli` account with best priority. */
export function selectClaudeAccount(accounts: Account[], accountId?: string): Account {
  if (accountId) {
    const account = accounts.find((a) => a.id === accountId);
    if (account?.provider !== 'claude-cli') {
      throw new ExecutorError(
        `runner.claudeCli.accountId "${accountId}" is not a claude-cli account`,
      );
    }
    if (!account.enabled) throw new ExecutorError(`claude-cli account "${accountId}" is disabled`);
    return account;
  }
  const candidates = accounts
    .filter((a) => a.provider === 'claude-cli' && a.enabled && a.status !== 'disabled')
    .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
  const first = candidates[0];
  if (!first) {
    throw new ExecutorError(
      'runner.executor is "claude-cli" but no enabled claude-cli account exists; add one first',
    );
  }
  return first;
}

export class ClaudeCliExecutor implements Executor {
  readonly name = 'claude-cli';

  constructor(private readonly options: ClaudeCliExecutorOptions) {}

  createSession(input: ExecutorTask): ExecutorSession {
    const log: ExecutorLogger = input.log ?? (() => undefined);
    let sessionId: string | undefined;
    let totalTokens = 0;

    const run = async (runOpts: ExecutorRunOptions): Promise<ExecutorResult> => {
      const opts = this.options;
      if (opts.maxTaskTokens !== undefined && totalTokens >= opts.maxTaskTokens) {
        return {
          summary: 'Stopped: per-task token budget reached.',
          stopReason: 'token_budget',
          iterations: 0,
          tokens: 0,
          totalTokens,
          changedFiles: [],
        };
      }
      const account = selectClaudeAccount(opts.accounts.list(), opts.accountId);
      const sandboxDir = opts.sandboxes.ensure(account.id);
      const settings = cliSettings({ account, sandboxDir }, 'claude');
      const shell = needsShell(resolveOnPath(settings.command));

      const args = ['-p', '--output-format', 'stream-json', '--verbose'];
      args.push('--permission-mode', 'acceptEdits');
      if (opts.model) {
        if (!SAFE_MODEL.test(opts.model)) {
          throw new ExecutorError('runner.claudeCli.model contains unsupported characters');
        }
        args.push('--model', opts.model);
      }
      const resume = runOpts.cycle > 0 && sessionId !== undefined && SAFE_SESSION.test(sessionId);
      if (resume && sessionId) args.push('--resume', sessionId);
      let tools = [...opts.allowedTools];
      if (shell) {
        const dropped = tools.filter((t) => !isShellSafeArg(t));
        if (dropped.length > 0) {
          log(
            'warn',
            `claude is a Windows .cmd shim; not pre-approving tools with unsafe characters: ${dropped.join(', ')}`,
          );
        }
        tools = tools.filter(isShellSafeArg);
      }
      if (tools.length > 0) args.push('--allowedTools', ...tools);

      let prompt: string;
      if (resume && runOpts.failureReport) {
        prompt = repairPrompt(runOpts.cycle, runOpts.failureReport);
      } else {
        prompt = `${DAVECODE_SYSTEM_PROMPT}\n\n${CLAUDE_CLI_INSTRUCTIONS}\n\n${input.context}`;
        if (runOpts.cycle > 0 && runOpts.failureReport) {
          prompt += `\n\n${repairPrompt(runOpts.cycle, runOpts.failureReport)}`;
        }
      }

      const timeout = AbortSignal.timeout(opts.timeoutMs ?? 1_800_000);
      const signal = runOpts.signal ? AbortSignal.any([runOpts.signal, timeout]) : timeout;
      log(
        'info',
        `delegating to Claude Code CLI (account ${account.id}${resume ? ', resumed' : ''})`,
      );

      let cli: ReturnType<typeof runCli>;
      try {
        cli = runCli({
          provider: 'claude-cli',
          accountId: account.id,
          settings,
          args,
          env: { CLAUDE_CONFIG_DIR: sandboxDir },
          cwd: input.root,
          stdin: prompt,
          signal,
        });
      } catch (err) {
        if (runOpts.signal?.aborted) throw new ExecutorAbortedError();
        throw new ExecutorError(err instanceof Error ? err.message : String(err), { cause: err });
      }

      let resultText: string | undefined;
      let isError = false;
      let tokens = 0;
      let turns = 0;
      try {
        for await (const raw of cli.events) {
          if (!isRecord(raw)) continue;
          const type = asString(raw.type);
          const sid = asString(raw.session_id);
          if (sid) sessionId = sid;
          if (type === 'assistant' && raw.parent_tool_use_id == null && isRecord(raw.message)) {
            turns++;
            const content = Array.isArray(raw.message.content) ? raw.message.content : [];
            for (const block of content) {
              if (isRecord(block) && block.type === 'tool_use') {
                log('debug', `claude tool ${asString(block.name) ?? 'unknown'}`);
              }
            }
          } else if (type === 'result') {
            resultText = asString(raw.result) ?? '';
            isError = raw.is_error === true || (asString(raw.subtype) ?? 'success') !== 'success';
            const usage = isRecord(raw.usage) ? raw.usage : {};
            tokens =
              (asNumber(usage.input_tokens) ?? 0) +
              (asNumber(usage.output_tokens) ?? 0) +
              (asNumber(usage.cache_creation_input_tokens) ?? 0);
          }
        }
      } catch (err) {
        if (runOpts.signal?.aborted) throw new ExecutorAbortedError();
        throw new ExecutorError(err instanceof Error ? err.message : String(err), { cause: err });
      }

      let exit: Awaited<typeof cli.exit>;
      try {
        exit = await cli.exit;
      } catch (err) {
        throw new ExecutorError(err instanceof Error ? err.message : String(err), { cause: err });
      }
      if (exit.aborted || signal.aborted) {
        if (runOpts.signal?.aborted) throw new ExecutorAbortedError();
        throw new ExecutorError(
          `Claude Code CLI timed out after ${opts.timeoutMs ?? 1_800_000} ms`,
        );
      }
      totalTokens += tokens;
      if (exit.code !== 0 || isError || resultText === undefined) {
        const detail = redact(
          (isError && resultText ? resultText : exit.stderr || resultText || '').trim(),
        ).slice(0, 1000);
        throw new ExecutorError(
          `Claude Code CLI failed (exit ${exit.code ?? 'none'})${detail ? `: ${detail}` : ''}`,
        );
      }
      return {
        summary: resultText.trim() || 'Implemented by Claude Code.',
        stopReason: 'completed',
        iterations: Math.max(1, turns),
        tokens,
        totalTokens,
        changedFiles: [],
      };
    };

    return { run };
  }
}
