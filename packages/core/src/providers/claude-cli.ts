import path from 'node:path';
import { ProviderError } from '../errors';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatRequest,
  FinishReason,
  ModelInfo,
  Provider,
  ProviderCallContext,
} from '../types';
import {
  classifyCliText,
  cliSettings,
  needsShell,
  renderTranscript,
  resolveOnPath,
  runCli,
  systemText,
} from './shared/cli';
import { collectCompletion } from './shared/collect';
import { redact } from './shared/errors';
import {
  asArray,
  asNumber,
  asString,
  configString,
  configStringArray,
  isRecord,
  makeChunk,
  makeUsage,
  modelList,
  newId,
  nowSeconds,
  stripProviderPrefix,
} from './shared/util';

const DEFAULT_MODELS = ['default', 'sonnet', 'opus', 'haiku'];
const SAFE_MODEL = /^[\w.:[\]-]+$/;

/**
 * Local Claude Code CLI adapter (subscription login). Spawns
 * `claude -p --output-format stream-json --verbose --include-partial-messages` headlessly with
 * `CLAUDE_CONFIG_DIR` set to the account's sandbox directory, so every account keeps its own
 * login. The conversation is sent on stdin as a transcript; the CLI's own tool use is not
 * surfaced, only its text. OpenAI `tools` in the request are ignored.
 *
 * Reads `account.config`: `binaryPath` (default `claude`), `binaryArgs` (prefix args, e.g.
 * `['script.js']` when `binaryPath` is `node`), `models` (advertised model list),
 * `systemPromptMode` (`append` (default) uses `--append-system-prompt`, `replace` uses
 * `--system-prompt`), `cwd` (working directory, default the sandbox dir).
 *
 * On Windows `.cmd`/`.bat` shims are run through the shell; the system prompt is then folded
 * into the stdin transcript instead of a command-line flag to avoid shell quoting problems.
 */
export class ClaudeCliProvider implements Provider {
  readonly kind = 'claude-cli' as const;

  async listModels(ctx: ProviderCallContext): Promise<ModelInfo[]> {
    const configured = configStringArray(ctx.account.config, 'models');
    return modelList(configured.length > 0 ? configured : DEFAULT_MODELS, this.kind);
  }

  async complete(req: ChatRequest, ctx: ProviderCallContext): Promise<ChatCompletion> {
    return collectCompletion(this.stream(req, ctx), stripProviderPrefix(req.model, this.kind));
  }

  async *stream(req: ChatRequest, ctx: ProviderCallContext): AsyncGenerator<ChatCompletionChunk> {
    const model = stripProviderPrefix(req.model, this.kind);
    const settings = cliSettings(ctx, 'claude');
    const shell = needsShell(resolveOnPath(settings.command));
    const system = systemText(req.messages);
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
    ];
    args.push('--no-session-persistence');
    if (model && model !== 'default') {
      if (!SAFE_MODEL.test(model)) {
        throw new ProviderError('claude-cli: unsupported characters in model id', {
          kind: 'bad_request',
          provider: this.kind,
          accountId: ctx.account.id,
        });
      }
      args.push('--model', model);
    }
    if (system && !shell) {
      const flag =
        configString(ctx.account.config, 'systemPromptMode') === 'replace'
          ? '--system-prompt'
          : '--append-system-prompt';
      args.push(flag, system);
    }

    const run = runCli({
      provider: this.kind,
      accountId: ctx.account.id,
      settings,
      args,
      env: { CLAUDE_CONFIG_DIR: ctx.sandboxDir },
      cwd: configString(ctx.account.config, 'cwd') ?? path.resolve(ctx.sandboxDir),
      stdin: renderTranscript(req.messages, shell),
      signal: ctx.signal,
    });

    const id = newId();
    const created = nowSeconds();
    let outModel = model;
    let started = false;
    let emittedText = false;
    let finished = false;
    const streamedMessages = new Set<string>();

    const fail = (message: string): ProviderError => {
      const { kind, retryAfterMs } = classifyCliText(message);
      return new ProviderError(`claude-cli: ${redact(message, ctx.secret).slice(0, 500)}`, {
        kind,
        retryAfterMs,
        provider: this.kind,
        accountId: ctx.account.id,
      });
    };

    const abortError = () =>
      new ProviderError('claude-cli request aborted', {
        kind: 'timeout',
        provider: this.kind,
        accountId: ctx.account.id,
      });

    for await (const raw of run.events) {
      if (!isRecord(raw)) continue;
      const type = asString(raw.type);
      const isSub = raw.parent_tool_use_id != null;

      if (type === 'system' && raw.subtype === 'init') {
        outModel = asString(raw.model) ?? outModel;
        continue;
      }

      if (type === 'stream_event' && !isSub && isRecord(raw.event)) {
        const ev = raw.event;
        if (ev.type === 'message_start' && isRecord(ev.message)) {
          const mid = asString(ev.message.id);
          if (mid) streamedMessages.add(mid);
          outModel = asString(ev.message.model) ?? outModel;
        } else if (
          ev.type === 'content_block_delta' &&
          isRecord(ev.delta) &&
          ev.delta.type === 'text_delta'
        ) {
          const text = asString(ev.delta.text);
          if (text) {
            if (!started) {
              started = true;
              yield makeChunk(id, outModel, created, { role: 'assistant', content: '' });
            }
            emittedText = true;
            yield makeChunk(id, outModel, created, { content: text });
          }
        }
        continue;
      }

      if (type === 'assistant' && !isSub && isRecord(raw.message)) {
        const mid = asString(raw.message.id);
        if (mid && streamedMessages.has(mid)) continue;
        const text = asArray(raw.message.content)
          .flatMap((b) => (isRecord(b) && b.type === 'text' ? [asString(b.text) ?? ''] : []))
          .join('');
        if (text) {
          if (!started) {
            started = true;
            yield makeChunk(id, outModel, created, { role: 'assistant', content: '' });
          }
          emittedText = true;
          yield makeChunk(id, outModel, created, { content: text });
        }
        continue;
      }

      if (type === 'result') {
        finished = true;
        const resultText = asString(raw.result) ?? '';
        const subtype = asString(raw.subtype) ?? '';
        if (raw.is_error === true || (subtype && subtype !== 'success')) {
          throw fail(resultText || `Claude CLI reported ${subtype || 'an error'}`);
        }
        if (!started) {
          started = true;
          yield makeChunk(id, outModel, created, { role: 'assistant', content: '' });
        }
        if (!emittedText && resultText) {
          yield makeChunk(id, outModel, created, { content: resultText });
        }
        const u = isRecord(raw.usage) ? raw.usage : {};
        const prompt =
          (asNumber(u.input_tokens) ?? 0) +
          (asNumber(u.cache_creation_input_tokens) ?? 0) +
          (asNumber(u.cache_read_input_tokens) ?? 0);
        const finish: FinishReason = raw.stop_reason === 'max_tokens' ? 'length' : 'stop';
        yield makeChunk(
          id,
          outModel,
          created,
          {},
          finish,
          makeUsage(prompt, asNumber(u.output_tokens) ?? 0),
        );
      }
    }

    const exit = await run.exit;
    if (exit.aborted || ctx.signal?.aborted) throw abortError();
    if (!finished) {
      const detail = exit.stderr.trim() || `process exited with code ${exit.code ?? 'unknown'}`;
      throw fail(detail);
    }
  }
}
