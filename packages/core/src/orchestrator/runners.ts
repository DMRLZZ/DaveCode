/**
 * Headless runners for the pane orchestrator. Each run spawns a vendor CLI the user already
 * signed in to (Claude Code `claude`, Codex `codex`, Antigravity `agy`) with the prompt on
 * stdin, and reduces its NDJSON stream to plain-text {@link AgentOutput} lines.
 *
 * The CLIs use their normal global sign-in, exactly like the desktop terminal panes: no
 * `CLAUDE_CONFIG_DIR` / `CODEX_HOME` sandbox is set.
 *
 * `plan` mode must not modify files:
 * - claude: `--permission-mode plan`, the built-in tools reduced to `Read Glob Grep` with
 *   `--tools`, and `--strict-mcp-config` so no MCP server (and none of its write tools) loads.
 *   The model cannot write even if it ignores plan mode, because no write tool exists.
 * - codex: `--sandbox read-only` (enforced by the OS sandbox), with `approval_policy=never` so
 *   a user config asking for approvals cannot hang the headless run.
 * - agy: its `--mode plan` is only a prompt (a `/plan` expansion, ignored with
 *   `--disable-slash-commands`) and headless runs auto-allow writes in the working directory,
 *   so plan runs happen in a fresh empty temp directory that is removed afterwards. The prompt
 *   is prefixed with a note that the repository is not visible.
 */
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  classifyCliText,
  isShellSafeArg,
  needsShell,
  resolveOnPath,
  runCli,
} from '../providers/shared/cli';
import { redact } from '../providers/shared/errors';
import { asArray, asNumber, asString, isRecord } from '../providers/shared/util';
import type { ProviderKind } from '../types';
import {
  type AgentAvailability,
  type AgentOutput,
  type AgentRunner,
  type AgentRunRequest,
  type AgentRunResult,
  ORCHESTRATOR_AGENTS,
  type OrchestratorAgent,
} from './contract';

export interface AgentBinary {
  /** Executable name (resolved on PATH) or absolute path. */
  command: string;
  /** Arguments placed before the runner's own (e.g. a script path when `command` is node). */
  args?: string[];
}

export interface CliAgentRunnerOptions {
  /** Environment for the CLIs (default `process.env`). Their global sign-in is used. */
  env?: NodeJS.ProcessEnv;
  /** Override the executable per agent (defaults `claude`, `codex`, `agy`). */
  binaries?: Partial<Record<OrchestratorAgent, AgentBinary>>;
  /** Parent of the scratch directories used for Antigravity plan runs (default OS temp). */
  scratchDir?: string;
}

const MAX_TEXT_CHUNK = 2000;
const MAX_TOOL_LINE = 200;
const MAX_ERROR = 300;

interface AgentInfo {
  label: string;
  binary: string;
  provider: ProviderKind;
  signIn: string;
}

const AGENTS: Record<OrchestratorAgent, AgentInfo> = {
  claude: {
    label: 'Claude Code',
    binary: 'claude',
    provider: 'claude-cli',
    signIn: 'run `claude` in a terminal and sign in',
  },
  codex: {
    label: 'Codex',
    binary: 'codex',
    provider: 'codex-cli',
    signIn: 'run `codex login` in a terminal',
  },
  agy: {
    label: 'Antigravity',
    binary: 'agy',
    provider: 'antigravity-cli',
    signIn: 'run `agy` in a terminal and sign in',
  },
};

export const AGY_PLAN_NOTE =
  'Note: you are running in an empty scratch directory, not inside the project, so you cannot ' +
  "see the repository's files. Answer from the information in this message only and do not " +
  'create files.';

/** The CLI arguments for an agent and mode (prompt excluded: it always goes on stdin). */
export function agentArgs(agent: OrchestratorAgent, mode: AgentRunRequest['mode']): string[] {
  switch (agent) {
    case 'claude':
      return mode === 'plan'
        ? [
            '-p',
            '--output-format',
            'stream-json',
            '--verbose',
            '--permission-mode',
            'plan',
            '--tools',
            'Read',
            'Glob',
            'Grep',
            '--strict-mcp-config',
          ]
        : ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits'];
    case 'codex':
      return [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--sandbox',
        mode === 'plan' ? 'read-only' : 'workspace-write',
        '-c',
        'approval_policy=never',
        '-',
      ];
    case 'agy':
      return [
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--sandbox',
        '--disable-slash-commands',
        '--print=',
      ];
  }
}

function agentStdin(
  agent: OrchestratorAgent,
  mode: AgentRunRequest['mode'],
  prompt: string,
): string {
  if (agent === 'agy') {
    const content = mode === 'plan' ? `${AGY_PLAN_NOTE}\n\n${prompt}` : prompt;
    return `${JSON.stringify({ event: 'user', message: { content } })}\n`;
  }
  // `claude -p` treats a leading slash as a slash command.
  if (agent === 'claude' && prompt.trimStart().startsWith('/')) return `Task:\n${prompt}`;
  return prompt;
}

function abortError(): Error {
  const err = new Error('The agent run was aborted');
  err.name = 'AbortError';
  return err;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{8,}/g, '[redacted]'],
  [/\bAIza[A-Za-z0-9_-]{20,}/g, '[redacted]'],
  [/\bya29\.[A-Za-z0-9._-]{10,}/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[redacted]'],
  [/\b(bearer)\s+[^\s"']+/gi, '$1 [redacted]'],
  [
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
    '$1$2[redacted]',
  ],
];

/** Removes anything that looks like a credential and collapses whitespace. */
export function scrubSecrets(text: string): string {
  let out = redact(text);
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function shortError(text: string): string {
  return clip(scrubSecrets(text), MAX_ERROR);
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.max(1, Math.ceil(ms / 1000))} s`;
}

function tail(text: string, max = 400): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(t.length - max);
}

/** `Edit src/x.ts`: a tool name plus a short hint taken from its input. */
function toolLine(name: string, input: unknown, cwd: string): string {
  let hint: string | undefined;
  if (isRecord(input)) {
    const lower = new Map(Object.entries(input).map(([k, v]) => [k.toLowerCase(), v]));
    for (const key of [
      'file_path',
      'filepath',
      'absolutepath',
      'path',
      'targetfile',
      'command',
      'commandline',
      'cmd',
      'pattern',
      'query',
      'url',
      'description',
    ]) {
      const value = lower.get(key);
      const str = typeof value === 'string' ? value : Array.isArray(value) ? value.join(' ') : '';
      if (str.trim()) {
        hint = str;
        break;
      }
    }
  }
  if (hint && path.isAbsolute(hint)) {
    const rel = path.relative(cwd, hint);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) hint = rel.split(path.sep).join('/');
  }
  return clip(scrubSecrets(hint ? `${name} ${hint}` : name), MAX_TOOL_LINE);
}

// --- Stream parsers ----------------------------------------------------------------------------

interface ParseState {
  /** Final reply. */
  text: string;
  /** The CLI reported a successful end of the turn. */
  completed: boolean;
  /** Failure reported in-stream. */
  failure?: string;
  tokens?: number;
}

interface StreamParser {
  state: ParseState;
  handle(event: unknown): void;
  flush(): void;
}

type Emit = (chunk: AgentOutput) => void;

function claudeParser(emit: Emit, cwd: string): StreamParser {
  const state: ParseState = { text: '', completed: false };
  let lastAssistant = '';
  return {
    state,
    flush() {},
    handle(raw) {
      if (!isRecord(raw)) return;
      const type = asString(raw.type);
      if (type === 'system' && raw.subtype === 'init') {
        const model = asString(raw.model);
        emit({
          kind: 'status',
          text: model ? `Claude Code started (${model})` : 'Claude Code started',
        });
        return;
      }
      if (type === 'assistant' && raw.parent_tool_use_id == null && isRecord(raw.message)) {
        const texts: string[] = [];
        for (const block of asArray(raw.message.content)) {
          if (!isRecord(block)) continue;
          if (block.type === 'text') {
            const t = asString(block.text)?.trim();
            if (t) texts.push(t);
          } else if (block.type === 'tool_use') {
            emit({
              kind: 'tool',
              text: toolLine(asString(block.name) ?? 'tool', block.input, cwd),
            });
          }
        }
        if (texts.length > 0) {
          lastAssistant = texts.join('\n');
          emit({ kind: 'text', text: clip(lastAssistant, MAX_TEXT_CHUNK) });
        }
        return;
      }
      if (type === 'result') {
        const result = asString(raw.result) ?? '';
        const subtype = asString(raw.subtype) ?? 'success';
        const u = isRecord(raw.usage) ? raw.usage : undefined;
        if (u) {
          state.tokens =
            (asNumber(u.input_tokens) ?? 0) +
            (asNumber(u.cache_creation_input_tokens) ?? 0) +
            (asNumber(u.cache_read_input_tokens) ?? 0) +
            (asNumber(u.output_tokens) ?? 0);
        }
        if (raw.is_error === true || subtype !== 'success') {
          state.failure = result || `Claude Code reported ${subtype}`;
          return;
        }
        state.completed = true;
        state.text = result || lastAssistant;
      }
    },
  };
}

function codexErrorText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (isRecord(value)) return asString(value.message) ?? JSON.stringify(value);
  return undefined;
}

function codexItemLine(item: Record<string, unknown>, cwd: string): string | undefined {
  const type = asString(item.type) ?? 'item';
  switch (type) {
    case 'reasoning':
    case 'todo_list':
      return undefined;
    case 'command_execution':
      return toolLine('Run', { command: asString(item.command) ?? '' }, cwd);
    case 'file_change': {
      const files = asArray(item.changes)
        .flatMap((c) => (isRecord(c) && asString(c.path) ? [asString(c.path) as string] : []))
        .map((f) => toolLine('', { path: f }, cwd).trim());
      return clip(`Edit ${files.join(', ')}`.trim(), MAX_TOOL_LINE);
    }
    case 'mcp_tool_call': {
      const name = [asString(item.server), asString(item.tool)].filter(Boolean).join('.');
      return toolLine(name || 'MCP tool', undefined, cwd);
    }
    case 'web_search':
      return toolLine('Search', { query: asString(item.query) ?? '' }, cwd);
    default:
      return toolLine(type, item, cwd);
  }
}

function codexParser(emit: Emit, cwd: string): StreamParser {
  const state: ParseState = { text: '', completed: false };
  const announced = new Set<string>();
  let lastError: string | undefined;
  return {
    state,
    flush() {
      if (!state.completed && !state.failure && lastError) state.failure = lastError;
    },
    handle(raw) {
      if (!isRecord(raw)) return;
      const ev = isRecord(raw.msg) ? raw.msg : raw;
      const type = asString(ev.type) ?? '';
      if (type === 'thread.started') {
        emit({ kind: 'status', text: 'Codex started' });
        return;
      }
      if ((type === 'item.started' || type === 'item.completed') && isRecord(ev.item)) {
        const item = ev.item;
        const itemType = asString(item.type);
        if (itemType === 'agent_message' || itemType === 'assistant_message') {
          if (type !== 'item.completed') return;
          const text = (asString(item.text) ?? asString(item.message) ?? '').trim();
          if (text) {
            state.text = text;
            emit({ kind: 'text', text: clip(text, MAX_TEXT_CHUNK) });
          }
          return;
        }
        if (itemType === 'error') {
          const message = asString(item.message);
          if (message && type === 'item.completed')
            emit({ kind: 'error', text: shortError(message) });
          return;
        }
        const id = asString(item.id) ?? `${itemType}-${announced.size}`;
        // A file change is only known once completed; other items show as soon as they start.
        if (itemType === 'file_change' && type !== 'item.completed') return;
        if (announced.has(id)) return;
        announced.add(id);
        const line = codexItemLine(item, cwd);
        if (line) emit({ kind: 'tool', text: line });
        return;
      }
      if (type === 'turn.completed' || type === 'task_complete') {
        state.completed = true;
        const last = asString(ev.last_agent_message);
        if (!state.text && last) state.text = last;
        const u = isRecord(ev.usage) ? ev.usage : undefined;
        if (u) state.tokens = (asNumber(u.input_tokens) ?? 0) + (asNumber(u.output_tokens) ?? 0);
        return;
      }
      if (type === 'turn.failed') {
        state.failure = codexErrorText(ev.error) ?? lastError ?? 'Codex reported an error';
        return;
      }
      if (type === 'error') {
        // Codex also reports transient retries this way; only fatal if the turn never completes.
        lastError = codexErrorText(ev.message) ?? codexErrorText(ev.error) ?? lastError;
        if (lastError) emit({ kind: 'error', text: shortError(lastError) });
        return;
      }
      if (type === 'agent_message') {
        const text = (asString(ev.message) ?? '').trim();
        if (text) {
          state.text = text;
          emit({ kind: 'text', text: clip(text, MAX_TEXT_CHUNK) });
        }
      }
    },
  };
}

function agyParser(emit: Emit, cwd: string): StreamParser {
  const state: ParseState = { text: '', completed: false };
  const announced = new Set<string>();
  let streamed = '';
  let buffer = '';
  let bufferStep: string | undefined;
  const flushText = () => {
    const text = buffer.trim();
    buffer = '';
    bufferStep = undefined;
    if (text) emit({ kind: 'text', text: clip(text, MAX_TEXT_CHUNK) });
  };
  return {
    state,
    flush: flushText,
    handle(raw) {
      if (!isRecord(raw)) return;
      const event = asString(raw.event);
      if (event === 'init') {
        emit({ kind: 'status', text: 'Antigravity started' });
        return;
      }
      if (event === 'step_update' && isRecord(raw.step_update)) {
        const step = raw.step_update;
        const stepType = asString(step.step_type);
        const index = String(asNumber(step.step_index) ?? asString(step.step_index) ?? '');
        if (stepType === 'agent_response') {
          if (bufferStep !== undefined && bufferStep !== index) flushText();
          const delta = asString(step.text_delta);
          if (delta) {
            bufferStep = index;
            buffer += delta;
            streamed += delta;
          }
          if (asString(step.state) === 'DONE') flushText();
          return;
        }
        if (stepType === 'tool') {
          flushText();
          if (announced.has(index)) return;
          announced.add(index);
          const info = isRecord(step.tool_info) ? step.tool_info : {};
          const name = asString(step.tool_name) ?? asString(info.name) ?? 'tool';
          emit({ kind: 'tool', text: toolLine(name, info.parameters, cwd) });
        }
        return;
      }
      if (event === 'result' && isRecord(raw.result)) {
        flushText();
        const result = raw.result;
        const u = isRecord(result.usage) ? result.usage : undefined;
        if (u) {
          state.tokens =
            (asNumber(u.input_tokens) ?? 0) +
            (asNumber(u.output_tokens) ?? 0) +
            (asNumber(u.thinking_tokens) ?? 0);
        }
        const status = asString(result.status);
        if (status !== 'SUCCESS') {
          state.failure =
            asString(result.error) ?? `Antigravity ended with ${status ?? 'an error'}`;
          return;
        }
        state.completed = true;
        state.text = (asString(result.response) ?? streamed).trim();
      }
    },
  };
}

const PARSERS: Record<OrchestratorAgent, (emit: Emit, cwd: string) => StreamParser> = {
  claude: claudeParser,
  codex: codexParser,
  agy: agyParser,
};

// --- Runner ------------------------------------------------------------------------------------

/** `detail` is shown; `evidence` (detail plus stderr) decides whether it is a sign-in/limit issue. */
function failureMessage(
  info: AgentInfo,
  detail: string,
  evidence: string,
  code: number | null,
): string {
  const { kind } = classifyCliText(evidence);
  if (kind === 'auth') return `${info.label} is not signed in: ${info.signIn}`;
  const clean = scrubSecrets(detail);
  if (kind === 'quota_exhausted') return shortError(`${info.label} usage limit reached: ${clean}`);
  if (kind === 'rate_limit') return shortError(`${info.label} is rate limited: ${clean}`);
  const exit = code !== null && code !== 0 ? ` (exit ${code})` : '';
  return shortError(`${info.label} failed${exit}${clean ? `: ${clean}` : ''}`);
}

export function createCliAgentRunner(options: CliAgentRunnerOptions = {}): AgentRunner {
  const env = options.env ?? process.env;
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') childEnv[k] = v;

  const resolveBinary = (agent: OrchestratorAgent): { command: string; prefix: string[] } => {
    const override = options.binaries?.[agent];
    const command = override?.command ?? AGENTS[agent].binary;
    return { command: resolveOnPath(command, env), prefix: override?.args ?? [] };
  };

  const isAvailable = (agent: OrchestratorAgent): boolean => {
    const { command } = resolveBinary(agent);
    if (!path.isAbsolute(command)) return false;
    try {
      return existsSync(command) && statSync(command).isFile();
    } catch {
      return false;
    }
  };

  async function run(request: AgentRunRequest): Promise<AgentRunResult> {
    if (request.signal.aborted) throw abortError();
    const info = AGENTS[request.agent];
    const { command, prefix } = resolveBinary(request.agent);
    const args = agentArgs(request.agent, request.mode);
    if (needsShell(command) && ![...prefix, ...args].every(isShellSafeArg)) {
      return { ok: false, text: '', error: `${info.label}: unsafe argument for the Windows shell` };
    }

    const emit: Emit = (chunk) => {
      try {
        request.onOutput(chunk);
      } catch {
        // a broken listener must not break the run
      }
    };

    // Antigravity cannot be kept read-only, so plan runs see an empty directory.
    let scratch: string | undefined;
    let cwd = request.cwd;
    if (request.agent === 'agy' && request.mode === 'plan') {
      scratch = mkdtempSync(path.join(options.scratchDir ?? tmpdir(), 'davecode-agy-plan-'));
      cwd = scratch;
    }

    const timeout = AbortSignal.timeout(request.timeoutMs);
    const signal = AbortSignal.any([request.signal, timeout]);
    const timedOut = (): AgentRunResult => ({
      ok: false,
      text: '',
      error: `${info.label} timed out after ${formatDuration(request.timeoutMs)}`,
    });

    try {
      let cli: ReturnType<typeof runCli>;
      try {
        cli = runCli({
          provider: info.provider,
          accountId: 'orchestrator',
          settings: { command, prefixArgs: prefix },
          args,
          env: childEnv,
          cwd,
          stdin: agentStdin(request.agent, request.mode, request.prompt),
          signal,
        });
      } catch (err) {
        if (request.signal.aborted) throw abortError();
        if (timeout.aborted) return timedOut();
        return { ok: false, text: '', error: shortError(errText(err)) };
      }

      const parser = PARSERS[request.agent](emit, cwd);
      let streamError: string | undefined;
      try {
        for await (const event of cli.events) parser.handle(event);
      } catch (err) {
        streamError = errText(err);
      }
      parser.flush();

      let exit: Awaited<typeof cli.exit>;
      try {
        exit = await cli.exit;
      } catch {
        if (request.signal.aborted) throw abortError();
        return {
          ok: false,
          text: '',
          error: `${info.label} could not be started: is \`${info.binary}\` installed and on PATH?`,
        };
      }
      if (request.signal.aborted) throw abortError();
      if (exit.aborted || timeout.aborted) return { ...timedOut(), text: parser.state.text };

      const { state } = parser;
      if (state.completed && !state.failure && exit.code === 0) {
        return {
          ok: true,
          text: state.text,
          ...(state.tokens !== undefined ? { tokens: state.tokens } : {}),
        };
      }
      const detail =
        state.failure ??
        streamError ??
        (tail(exit.stderr) ||
          (exit.code === 0 ? 'the CLI ended without a final result' : 'no output'));
      return {
        ok: false,
        text: state.text,
        error: failureMessage(info, detail, `${detail}\n${tail(exit.stderr)}`, exit.code),
        ...(state.tokens !== undefined ? { tokens: state.tokens } : {}),
      };
    } finally {
      if (scratch) {
        try {
          rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {
          // best effort: the OS temp dir is cleaned eventually
        }
      }
    }
  }

  return {
    async availability(): Promise<AgentAvailability[]> {
      return ORCHESTRATOR_AGENTS.map((agent) => ({ agent, available: isAvailable(agent) }));
    },
    run,
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
