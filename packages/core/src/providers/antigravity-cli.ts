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

/**
 * Google Antigravity CLI adapter (`agy`, the user's own Google sign-in). Spawns
 * `agy --input-format stream-json --output-format stream-json --sandbox
 * --disable-slash-commands [--model m] --print=` and writes one
 * `{ "event": "user", "message": { "content": transcript } }` line to stdin, so long
 * conversations never hit command-line length limits.
 *
 * Output is NDJSON with an `event` envelope: `init`, `step_update` (`step_type`
 * `agent_response` carries `text_delta`) and one `result` per turn with `status`, `response`,
 * `error` and `usage` (`input_tokens`, `output_tokens`, `thinking_tokens`). Verified with
 * agy 1.4.8 on Windows (2026-10-28) against its headless documentation.
 *
 * Headless runs auto-allow file reads and writes in the working directory, so the default
 * working directory is the account's sandbox, never a project, and `--sandbox` restricts the
 * terminal. Antigravity keeps its login in the OS keyring with no per-account home, so all
 * Antigravity accounts share the machine's sign-in.
 *
 * Reads `account.config`: `binaryPath` (default `agy`), `binaryArgs` (prefix args), `models`,
 * `cwd` (default the sandbox dir).
 */
export class AntigravityCliProvider implements Provider {
  readonly kind = 'antigravity-cli' as const;

  async listModels(ctx: ProviderCallContext): Promise<ModelInfo[]> {
    const configured = configStringArray(ctx.account.config, 'models');
    return modelList(configured.length > 0 ? configured : ['default'], this.kind);
  }

  async complete(req: ChatRequest, ctx: ProviderCallContext): Promise<ChatCompletion> {
    return collectCompletion(this.stream(req, ctx), stripProviderPrefix(req.model, this.kind));
  }

  async *stream(req: ChatRequest, ctx: ProviderCallContext): AsyncGenerator<ChatCompletionChunk> {
    const model = stripProviderPrefix(req.model, this.kind);
    if (model && !SAFE_MODEL.test(model)) {
      throw new ProviderError('antigravity-cli: unsupported characters in model id', {
        kind: 'bad_request',
        provider: this.kind,
        accountId: ctx.account.id,
      });
    }
    const args = [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--sandbox',
      '--disable-slash-commands',
    ];
    if (model && model !== 'default') args.push('--model', model);
    // `--print` takes the prompt as its value; empty means "read it from stdin".
    args.push('--print=');

    const run = runCli({
      provider: this.kind,
      accountId: ctx.account.id,
      settings: cliSettings(ctx, 'agy'),
      args,
      env: {},
      cwd: configString(ctx.account.config, 'cwd') ?? path.resolve(ctx.sandboxDir),
      stdin: `${JSON.stringify({
        event: 'user',
        message: { content: renderTranscript(req.messages, true) },
      })}\n`,
      signal: ctx.signal,
    });

    const id = newId();
    const created = nowSeconds();
    let started = false;
    let streamed = false;
    let completed = false;
    let failure: string | undefined;

    const fail = (message: string): ProviderError => {
      const { kind, retryAfterMs } = classifyCliText(message);
      return new ProviderError(`antigravity-cli: ${redact(message, ctx.secret).slice(0, 500)}`, {
        kind,
        retryAfterMs,
        provider: this.kind,
        accountId: ctx.account.id,
      });
    };
    const start = function* () {
      if (started) return;
      started = true;
      yield makeChunk(id, model, created, { role: 'assistant', content: '' });
    };

    for await (const raw of run.events) {
      if (!isRecord(raw)) continue;
      const event = asString(raw.event);

      if (event === 'step_update' && isRecord(raw.step_update)) {
        const step = raw.step_update;
        const delta = asString(step.text_delta);
        if (asString(step.step_type) === 'agent_response' && delta) {
          yield* start();
          streamed = true;
          yield makeChunk(id, model, created, { content: delta });
        }
        continue;
      }

      if (event === 'result' && isRecord(raw.result)) {
        const result = raw.result;
        if (asString(result.status) !== 'SUCCESS') {
          failure = asString(result.error) ?? `Antigravity ended with ${result.status}`;
          break;
        }
        completed = true;
        yield* start();
        const response = asString(result.response);
        if (!streamed && response) yield makeChunk(id, model, created, { content: response });
        const u = isRecord(result.usage) ? result.usage : {};
        const output = (asNumber(u.output_tokens) ?? 0) + (asNumber(u.thinking_tokens) ?? 0);
        yield makeChunk(
          id,
          model,
          created,
          {},
          'stop',
          makeUsage(asNumber(u.input_tokens) ?? 0, output),
        );
        break;
      }
    }

    const exit = await run.exit;
    if (exit.aborted || ctx.signal?.aborted) {
      throw new ProviderError('antigravity-cli request aborted', {
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
