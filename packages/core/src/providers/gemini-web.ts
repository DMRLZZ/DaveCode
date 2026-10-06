/**
 * EXPERIMENTAL - TERMS OF SERVICE RISK.
 *
 * This adapter fronts a consumer Gemini web session (gemini.google.com) through an injected
 * driver. Automating a consumer web UI very likely violates Google's Terms of Service; accounts
 * used this way can be rate limited or suspended. It is disabled unless the user opts in with
 * `experimental.geminiWeb`, and nothing here talks to Google directly.
 *
 * This file deliberately contains NO browser automation: it does not import Playwright or any
 * Chromium code and never reads cookies. Whoever enables the feature supplies a
 * {@link GeminiWebDriver} implementation (for example one that drives a dedicated Chromium
 * profile in `ctx.sandboxDir`). Without a driver every call fails with an `unavailable` error.
 */
import { ProviderError } from '../errors';
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatRequest,
  ModelInfo,
  Provider,
  ProviderCallContext,
} from '../types';
import { renderTranscript } from './shared/cli';
import { collectCompletion } from './shared/collect';
import { toProviderError } from './shared/errors';
import {
  configStringArray,
  makeChunk,
  makeUsage,
  modelList,
  newId,
  nowSeconds,
  stripProviderPrefix,
} from './shared/util';

/** Bridge to a logged-in Gemini web session. Implemented outside of `core`. */
export interface GeminiWebDriver {
  /**
   * Send one prompt and stream back the reply as text fragments (deltas, not cumulative text).
   * Implementations should stop promptly when `signal` aborts and throw `ProviderError`
   * (e.g. kind `auth` when the session is logged out) for upstream failures.
   */
  send(
    prompt: string,
    options: { signal?: AbortSignal; sandboxDir?: string },
  ): AsyncIterable<string>;
}

/** Rough token estimate (the web UI exposes no usage data). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * `gemini-web` adapter. Reads `account.config.models` (advertised model list; default
 * `['gemini-web']`). Usage in the final chunk is an estimate (about 4 characters per token).
 */
export class GeminiWebProvider implements Provider {
  readonly kind = 'gemini-web' as const;

  constructor(private readonly driver?: GeminiWebDriver) {}

  async listModels(ctx: ProviderCallContext): Promise<ModelInfo[]> {
    const configured = configStringArray(ctx.account.config, 'models');
    return modelList(configured.length > 0 ? configured : ['gemini-web'], this.kind);
  }

  async complete(req: ChatRequest, ctx: ProviderCallContext): Promise<ChatCompletion> {
    return collectCompletion(this.stream(req, ctx), stripProviderPrefix(req.model, this.kind));
  }

  async *stream(req: ChatRequest, ctx: ProviderCallContext): AsyncGenerator<ChatCompletionChunk> {
    const scope = { provider: this.kind, accountId: ctx.account.id, secret: ctx.secret };
    if (!this.driver) {
      throw new ProviderError(
        'gemini-web is experimental and needs a GeminiWebDriver. It automates a consumer web ' +
          "session, may violate Google's Terms of Service, and no driver is configured.",
        { kind: 'unavailable', provider: this.kind, accountId: ctx.account.id },
      );
    }
    const model = stripProviderPrefix(req.model, this.kind);
    const prompt = renderTranscript(req.messages, true);
    const id = newId();
    const created = nowSeconds();
    let output = 0;
    try {
      yield makeChunk(id, model, created, { role: 'assistant', content: '' });
      for await (const text of this.driver.send(prompt, {
        signal: ctx.signal,
        sandboxDir: ctx.sandboxDir,
      })) {
        if (ctx.signal?.aborted) break;
        if (!text) continue;
        output += estimateTokens(text);
        yield makeChunk(id, model, created, { content: text });
      }
      if (ctx.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      yield makeChunk(id, model, created, {}, 'stop', makeUsage(estimateTokens(prompt), output));
    } catch (err) {
      throw toProviderError(err, scope, ctx.signal);
    }
  }
}
