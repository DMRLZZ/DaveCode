import path from 'node:path';
import { ProviderError } from '../errors';
import { geminiHomeEnv, seedGeminiHome } from '../identity/sandbox';
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

const DEFAULT_MODELS = ['default', 'gemini-2.5-pro', 'gemini-2.5-flash'];
const SAFE_MODEL = /^[\w.:[\]-]+$/;

/**
 * Environment for every Gemini CLI process of an account: its home points at the sandbox and
 * API-key variables are blanked so a key in the parent environment never overrides the
 * account's Google login.
 */
export function geminiCliEnv(sandboxDir: string): Record<string, string> {
  return {
    ...geminiHomeEnv(path.resolve(sandboxDir)),
    GEMINI_API_KEY: '',
    GOOGLE_API_KEY: '',
    GOOGLE_GENAI_USE_VERTEXAI: '',
  };
}

function errorText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (isRecord(value)) return asString(value.message) ?? JSON.stringify(value);
  return undefined;
}

/**
 * Local Gemini CLI adapter (official "Login with Google" subscription/free-tier login).
 * Spawns `gemini --output-format stream-json [-m model]` with the transcript (system prompt
 * included) on stdin, which runs Gemini CLI non-interactively. The account's sandbox becomes
 * the CLI's home (`GEMINI_CLI_HOME`, plus `HOME`/`USERPROFILE`), so `~/.gemini` (settings and
 * the cached Google OAuth credentials Gemini CLI writes itself) is per account. A fresh sandbox
 * is seeded with settings that select `oauth-personal`.
 *
 * The NDJSON parser is tolerant: it understands `message` events from the assistant (with or
 * without `delta`), `error` events, and the final `result` event (`status`, `error`,
 * `stats.input_tokens` / `stats.output_tokens`), plus a single `{ response, stats }` object as
 * printed by `--output-format json` on older builds. Unknown events (`init`, `tool_use`,
 * `tool_result`) are ignored. Not verified against a local install.
 *
 * Reads `account.config`: `binaryPath` (default `gemini`), `binaryArgs` (prefix args),
 * `models`, `cwd` (default the sandbox dir).
 */
export class GeminiCliProvider implements Provider {
  readonly kind = 'gemini-cli' as const;

  async listModels(ctx: ProviderCallContext): Promise<ModelInfo[]> {
    const configured = configStringArray(ctx.account.config, 'models');
    return modelList(configured.length > 0 ? configured : DEFAULT_MODELS, this.kind);
  }

  async complete(req: ChatRequest, ctx: ProviderCallContext): Promise<ChatCompletion> {
    return collectCompletion(this.stream(req, ctx), stripProviderPrefix(req.model, this.kind));
  }

  async *stream(req: ChatRequest, ctx: ProviderCallContext): AsyncGenerator<ChatCompletionChunk> {
    const model = stripProviderPrefix(req.model, this.kind);
    if (model && !SAFE_MODEL.test(model)) {
      throw new ProviderError('gemini-cli: unsupported characters in model id', {
        kind: 'bad_request',
        provider: this.kind,
        accountId: ctx.account.id,
      });
    }
    const args = ['--output-format', 'stream-json'];
    if (model && model !== 'default') args.push('-m', model);

    seedGeminiHome(ctx.sandboxDir);
    const run = runCli({
      provider: this.kind,
      accountId: ctx.account.id,
      settings: cliSettings(ctx, 'gemini'),
      args,
      env: geminiCliEnv(ctx.sandboxDir),
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
      return new ProviderError(`gemini-cli: ${redact(message, ctx.secret).slice(0, 500)}`, {
        kind,
        retryAfterMs,
        provider: this.kind,
        accountId: ctx.account.id,
      });
    };
    const open = (): ChatCompletionChunk | undefined => {
      if (started) return undefined;
      started = true;
      return makeChunk(id, model, created, { role: 'assistant', content: '' });
    };
    const usageOf = (stats: unknown) => {
      const s = isRecord(stats) ? stats : {};
      return makeUsage(asNumber(s.input_tokens) ?? 0, asNumber(s.output_tokens) ?? 0);
    };

    for await (const ev of run.events) {
      if (!isRecord(ev)) continue;
      const type = asString(ev.type);

      if (type === undefined && typeof ev.response === 'string') {
        const first = open();
        if (first) yield first;
        if (ev.response) yield makeChunk(id, model, created, { content: ev.response });
        if (ev.error) failure = errorText(ev.error);
        else {
          completed = true;
          yield makeChunk(id, model, created, {}, 'stop', usageOf(ev.stats));
        }
        break;
      }

      if (type === 'message' && ev.role === 'assistant') {
        const text = asString(ev.content);
        if (text) {
          const first = open();
          if (first) yield first;
          yield makeChunk(id, model, created, { content: text });
        }
        continue;
      }

      if (type === 'error') {
        if (asString(ev.severity) === 'warning') continue;
        failure = errorText(ev.message) ?? errorText(ev.error) ?? 'Gemini CLI reported an error';
        continue;
      }

      if (type === 'result') {
        if (asString(ev.status) === 'error' || ev.error) {
          failure = errorText(ev.error) ?? failure ?? 'Gemini CLI reported an error';
          break;
        }
        completed = true;
        const first = open();
        if (first) yield first;
        yield makeChunk(id, model, created, {}, 'stop', usageOf(ev.stats));
        break;
      }
    }

    const exit = await run.exit;
    if (exit.aborted || ctx.signal?.aborted) {
      throw new ProviderError('gemini-cli request aborted', {
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
