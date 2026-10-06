import path from 'node:path';
import { ProviderError } from '../errors';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatRequest,
  ModelInfo,
  Provider,
  ProviderCallContext,
} from '../types';
import { classifyCliText, cliSettings, renderTranscript, runCli } from './shared/cli';
import { collectCompletion } from './shared/collect';
import { redact } from './shared/errors';
import {
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

const SAFE_MODEL = /^[\w.:[\]-]+$/;

/** Pull the text of an agent message out of the (version-dependent) event shapes. */
function agentText(item: Record<string, unknown>): string | undefined {
  const type = asString(item.type);
  if (type && type !== 'agent_message' && type !== 'assistant_message') return undefined;
  const text = asString(item.text) ?? asString(item.message);
  if (text !== undefined) return text;
  if (Array.isArray(item.content)) {
    return item.content.flatMap((c) => (isRecord(c) ? [asString(c.text) ?? ''] : [])).join('');
  }
  return undefined;
}

function errorText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (isRecord(value)) return asString(value.message) ?? JSON.stringify(value);
  return undefined;
}

/**
 * Local OpenAI Codex CLI adapter (ChatGPT subscription login). Spawns
 * `codex exec --json --skip-git-repo-check --ephemeral --sandbox read-only [-m model] -` with
 * `CODEX_HOME` set to the account's sandbox directory and the transcript (system prompt
 * included) on stdin.
 *
 * The JSONL parser is deliberately tolerant. It understands the documented events
 * `thread.started`, `turn.started`, `item.completed` (`agent_message` items with `text`),
 * `turn.completed` (`usage.input_tokens` / `cached_input_tokens` / `output_tokens`),
 * `turn.failed` and `error`, plus the older `{ msg: { type, ... } }` envelope. Unknown events
 * are ignored. Codex emits whole messages (no token deltas), so each agent message is one chunk.
 * The event format was not verified against a local Codex install.
 *
 * Reads `account.config`: `binaryPath` (default `codex`), `binaryArgs` (prefix args), `models`,
 * `sandbox` (`read-only` default, passed to `--sandbox`), `cwd` (default the sandbox dir).
 */
export class CodexCliProvider implements Provider {
  readonly kind = 'codex-cli' as const;

  async listModels(ctx: ProviderCallContext): Promise<ModelInfo[]> {
    const configured = configStringArray(ctx.account.config, 'models');
    return modelList(configured.length > 0 ? configured : ['default'], this.kind);
  }

  async complete(req: ChatRequest, ctx: ProviderCallContext): Promise<ChatCompletion> {
    return collectCompletion(this.stream(req, ctx), stripProviderPrefix(req.model, this.kind));
  }

  async *stream(req: ChatRequest, ctx: ProviderCallContext): AsyncGenerator<ChatCompletionChunk> {
    const model = stripProviderPrefix(req.model, this.kind);
    const sandbox = configString(ctx.account.config, 'sandbox') ?? 'read-only';
    if (!SAFE_MODEL.test(sandbox) || (model && !SAFE_MODEL.test(model))) {
      throw new ProviderError('codex-cli: unsupported characters in model or sandbox setting', {
        kind: 'bad_request',
        provider: this.kind,
        accountId: ctx.account.id,
      });
    }
    const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--sandbox', sandbox];
    if (model && model !== 'default') args.push('-m', model);
    args.push('-');

    const run = runCli({
      provider: this.kind,
      accountId: ctx.account.id,
      settings: cliSettings(ctx, 'codex'),
      args,
      env: { CODEX_HOME: ctx.sandboxDir },
      cwd: configString(ctx.account.config, 'cwd') ?? path.resolve(ctx.sandboxDir),
      stdin: renderTranscript(req.messages, true),
      signal: ctx.signal,
    });

    const id = newId();
    const created = nowSeconds();
    let started = false;
    let completed = false;
    let failure: string | undefined;

    const fail = (message: string): ProviderError => {
      const { kind, retryAfterMs } = classifyCliText(message);
      return new ProviderError(`codex-cli: ${redact(message, ctx.secret).slice(0, 500)}`, {
        kind,
        retryAfterMs,
        provider: this.kind,
        accountId: ctx.account.id,
      });
    };

    for await (const raw of run.events) {
      if (!isRecord(raw)) continue;
      // Older builds wrap events as { id, msg: { type, ... } }.
      const ev = isRecord(raw.msg) ? raw.msg : raw;
      const type = asString(ev.type) ?? '';

      let text: string | undefined;
      if (type === 'item.completed' && isRecord(ev.item)) text = agentText(ev.item);
      else if (type === 'agent_message') text = agentText(ev);

      if (text) {
        if (!started) {
          started = true;
          yield makeChunk(id, model, created, { role: 'assistant', content: '' });
        }
        yield makeChunk(id, model, created, { content: text });
        continue;
      }

      if (type === 'turn.failed' || type === 'error') {
        failure =
          errorText(ev.error) ?? errorText(ev.message) ?? failure ?? 'Codex reported an error';
        if (type === 'turn.failed') break;
        continue;
      }

      if (type === 'turn.completed' || type === 'task_complete') {
        completed = true;
        if (!started) {
          started = true;
          yield makeChunk(id, model, created, { role: 'assistant', content: '' });
          const last = asString(ev.last_agent_message);
          if (last) yield makeChunk(id, model, created, { content: last });
        }
        const u = isRecord(ev.usage) ? ev.usage : {};
        // cached_input_tokens is a subset of input_tokens in Codex's accounting.
        const prompt = asNumber(u.input_tokens) ?? 0;
        yield makeChunk(
          id,
          model,
          created,
          {},
          'stop',
          makeUsage(prompt, asNumber(u.output_tokens) ?? 0),
        );
        break;
      }
    }

    const exit = await run.exit;
    if (exit.aborted || ctx.signal?.aborted) {
      throw new ProviderError('codex-cli request aborted', {
        kind: 'timeout',
        provider: this.kind,
        accountId: ctx.account.id,
      });
    }
    if (failure) throw fail(failure);
    if (!completed) {
      throw fail(exit.stderr.trim() || `process exited with code ${exit.code ?? 'unknown'}`);
    }
  }
}
