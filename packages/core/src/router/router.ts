import type { DaveConfig } from '../config/schema';
import { ProviderError } from '../errors';
import type { EventBus } from '../events';
import type { ChromiumProfileManager } from '../identity/chromium';
import { type Keyring, KeyringError } from '../identity/keyring';
import type { SandboxManager } from '../identity/sandbox';
import { countTextTokens, estimateTokens } from '../rate-limiter/tokens';
import type { UsageTracker } from '../rate-limiter/tracker';
import type { Clock, QuotaEngine } from '../rate-limiter/window';
import type { AccountRepository } from '../storage/accounts';
import { newId } from '../storage/ids';
import {
  type Account,
  type ChatCompletion,
  type ChatCompletionChunk,
  type ChatMessage,
  type ChatRequest,
  EXPERIMENTAL_PROVIDER_KINDS,
  type ModelInfo,
  type Provider,
  type ProviderCallContext,
  type ProviderErrorKind,
  type ProviderKind,
  SUBSCRIPTION_PROVIDER_KINDS,
  type UsageStatus,
} from '../types';
import { type Candidate, configuredModels, parseModel, resolveCandidates } from './candidates';
import { CircuitBreaker, type CircuitBreakerOptions } from './circuit-breaker';
import { RouterError } from './errors';

export interface RouterOptions {
  config: DaveConfig;
  accounts: AccountRepository;
  providers: Map<ProviderKind, Provider>;
  quota: QuotaEngine;
  tracker: UsageTracker;
  events: EventBus;
  sandboxes: SandboxManager;
  /** Profile manager for browser-backed providers (`gemini-web`). */
  chromium?: ChromiumProfileManager;
  /** Source of decrypted account secrets. */
  keyring?: Keyring;
  clock?: Clock;
  /** Uniform [0, 1) source used for weighted balancing (inject for deterministic tests). */
  random?: () => number;
  /** Defaults: 5 consecutive failures, reset after `routing.cooldownMs`. */
  breaker?: CircuitBreakerOptions;
}

/** Routing outcome, surfaced by the gateway as `x-davecode-*` headers. */
export interface RoutingMeta {
  requestId: string;
  accountId: string;
  provider: ProviderKind;
  /** Concrete model sent upstream. */
  model: string;
  /** Failover hops taken before the serving account. */
  failovers: number;
}

export interface RouteRequestOptions {
  /** Correlation id; generated when omitted. */
  requestId?: string;
  signal?: AbortSignal;
}

export interface CompletionResult {
  completion: ChatCompletion;
  meta: RoutingMeta;
}

export interface StreamResult {
  meta: RoutingMeta;
  /** Upstream chunks. Errors after the first chunk are thrown from the iterator. */
  chunks: AsyncIterable<ChatCompletionChunk>;
}

/** Why an account was not eligible for a request. */
export type SkipReason =
  | 'disabled'
  | 'error'
  | 'experimental'
  | 'no_provider'
  | 'subscription'
  | 'cooldown'
  | 'circuit_open'
  | 'quota';

export interface RankedCandidate extends Candidate {
  /** weight × headroom × backpressure factor. */
  effectiveWeight: number;
  /** True when the 5 h utilization is above `routing.quotaShiftThreshold`. */
  shifted: boolean;
}

export interface RoutingPlan {
  candidates: RankedCandidate[];
  skipped: Array<{ accountId: string; model: string; reason: SkipReason }>;
}

/** Error kinds that count against an account's circuit breaker. */
const BREAKER_KINDS: ReadonlySet<ProviderErrorKind> = new Set([
  'rate_limit',
  'quota_exhausted',
  'unavailable',
  'timeout',
  'network',
  'unknown',
]);

const CAPACITY_REASONS: ReadonlySet<SkipReason> = new Set(['cooldown', 'circuit_open', 'quota']);

function messageText(message: Partial<ChatMessage> | undefined): string {
  if (!message) return '';
  let text = '';
  const { content } = message;
  if (typeof content === 'string') text += content;
  else if (Array.isArray(content)) {
    for (const part of content) if (part.type === 'text') text += part.text;
  }
  for (const call of message.tool_calls ?? []) {
    text += call.function?.name ?? '';
    text += call.function?.arguments ?? '';
  }
  return text;
}

function toProviderError(err: unknown, account: Account): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof KeyringError) {
    return new ProviderError(err.message, {
      kind: 'auth',
      provider: account.provider,
      accountId: account.id,
      cause: err,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ProviderError(message, {
    kind: 'unknown',
    provider: account.provider,
    accountId: account.id,
    cause: err,
  });
}

/**
 * Quota-aware account selection with hot failover (see docs/ARCHITECTURE.md
 * "Routing & quotas"). Providers are injected; the router never talks to the network itself.
 */
export class Router {
  readonly breaker: CircuitBreaker;
  private readonly clock: Clock;
  private readonly random: () => number;

  constructor(private readonly options: RouterOptions) {
    this.clock = options.clock ?? options.quota.clock;
    this.random = options.random ?? Math.random;
    this.breaker = new CircuitBreaker({
      resetMs: options.config.routing.cooldownMs,
      clock: this.clock,
      ...options.breaker,
    });
  }

  private get config(): DaveConfig {
    return this.options.config;
  }

  /** The single account per subscription provider allowed when rotation is off. */
  private primarySubscriptionAccounts(accounts: readonly Account[]): Map<ProviderKind, string> {
    const primary = new Map<ProviderKind, Account>();
    for (const account of accounts) {
      if (!account.enabled || !SUBSCRIPTION_PROVIDER_KINDS.includes(account.provider)) continue;
      const best = primary.get(account.provider);
      if (
        !best ||
        account.priority < best.priority ||
        (account.priority === best.priority && account.createdAt < best.createdAt)
      ) {
        primary.set(account.provider, account);
      }
    }
    return new Map([...primary].map(([kind, account]) => [kind, account.id]));
  }

  private skipReason(
    account: Account,
    estimate: number,
    primaries: Map<ProviderKind, string>,
    now: number,
  ): SkipReason | undefined {
    if (!account.enabled || account.status === 'disabled') return 'disabled';
    if (account.status === 'error') return 'error';
    if (
      EXPERIMENTAL_PROVIDER_KINDS.includes(account.provider) &&
      !this.config.experimental.geminiWeb
    ) {
      return 'experimental';
    }
    if (!this.options.providers.has(account.provider)) return 'no_provider';
    if (
      SUBSCRIPTION_PROVIDER_KINDS.includes(account.provider) &&
      !this.config.experimental.multiAccountRotation &&
      primaries.get(account.provider) !== account.id
    ) {
      return 'subscription';
    }
    if (account.cooldownUntil && Date.parse(account.cooldownUntil) > now) return 'cooldown';
    if (!this.breaker.allow(account.id)) return 'circuit_open';
    if (this.options.quota.wouldExceed(account, estimate)) return 'quota';
    return undefined;
  }

  /** Resolve, filter and rank the accounts that could serve `req`, best first. */
  plan(
    req: Pick<ChatRequest, 'model' | 'messages'>,
    estimate = estimateTokens(req.messages),
  ): RoutingPlan {
    const { routing } = this.config;
    const accounts = this.options.accounts.list();
    const spec = parseModel(req.model, routing.routes, routing.defaultRoute);
    const all = resolveCandidates(spec, accounts);
    const primaries = this.primarySubscriptionAccounts(accounts);
    const now = this.clock();

    const skipped: RoutingPlan['skipped'] = [];
    const ranked: Array<RankedCandidate & { key: number }> = [];
    for (const candidate of all) {
      const reason = this.skipReason(candidate.account, estimate, primaries, now);
      if (reason) {
        skipped.push({ accountId: candidate.account.id, model: candidate.model, reason });
        continue;
      }
      const { account } = candidate;
      const usage = this.options.quota.usage(account);
      const maxUtil = Math.max(
        usage.windows['1m'].utilization,
        usage.windows['5h'].utilization,
        usage.windows['24h'].utilization,
      );
      const headroom = Math.min(1, Math.max(0, 1 - maxUtil));
      const bp = routing.backpressureThreshold;
      const backpressure = maxUtil > bp ? (bp >= 1 ? 0 : Math.max(0, (1 - maxUtil) / (1 - bp))) : 1;
      const effectiveWeight = Math.max(0, account.weight) * headroom * backpressure;
      const shifted = usage.windows['5h'].utilization >= routing.quotaShiftThreshold;
      // Weighted random order (Efraimidis–Spirakis): larger weight → larger key on average.
      const key = effectiveWeight > 0 ? this.random() ** (1 / effectiveWeight) : 0;
      ranked.push({ ...candidate, effectiveWeight, shifted, key });
    }

    ranked.sort(
      (a, b) =>
        a.targetIndex - b.targetIndex ||
        Number(a.shifted) - Number(b.shifted) ||
        a.account.priority - b.account.priority ||
        b.key - a.key ||
        b.effectiveWeight - a.effectiveWeight ||
        a.account.createdAt.localeCompare(b.account.createdAt) ||
        a.account.id.localeCompare(b.account.id),
    );
    return { candidates: ranked.map(({ key: _key, ...rest }) => rest), skipped };
  }

  private noCandidateError(req: ChatRequest, plan: RoutingPlan, requestId: string): RouterError {
    if (plan.skipped.length === 0) {
      return new RouterError('model_not_found', `No account can serve model "${req.model}"`, {
        requestId,
      });
    }
    const reasons = new Set(plan.skipped.map((s) => s.reason));
    if ([...reasons].some((r) => CAPACITY_REASONS.has(r))) {
      return new RouterError(
        'no_capacity',
        `Every account for "${req.model}" is saturated or cooling down`,
        { requestId },
      );
    }
    if (reasons.size === 1 && reasons.has('experimental')) {
      return new RouterError(
        'experimental_disabled',
        `"${req.model}" is only served by experimental providers; enable experimental.geminiWeb to use them`,
        { requestId },
      );
    }
    return new RouterError(
      'no_available_account',
      `No available account for "${req.model}" (${[...reasons].join(', ')})`,
      { requestId },
    );
  }

  private contextFor(account: Account, signal?: AbortSignal): ProviderCallContext {
    const { chromium, sandboxes, keyring } = this.options;
    const sandboxDir =
      account.provider === 'gemini-web' && chromium
        ? chromium.ensure(account.id)
        : sandboxes.ensure(account.id);
    const ctx: ProviderCallContext = { account, sandboxDir };
    const secret = keyring?.get(account.id);
    if (secret !== undefined) ctx.secret = secret;
    if (signal) ctx.signal = signal;
    return ctx;
  }

  private emitAccount(account: Account | undefined): void {
    if (account) this.options.events.emit({ type: 'account.updated', account });
  }

  private recordUsage(
    candidate: Candidate,
    requestId: string,
    status: UsageStatus,
    promptTokens: number,
    completionTokens: number,
    latencyMs: number,
    errorKind?: ProviderErrorKind,
  ): void {
    const record = {
      id: newId('use'),
      requestId,
      accountId: candidate.account.id,
      provider: candidate.provider,
      model: candidate.model,
      promptTokens,
      completionTokens,
      latencyMs,
      status,
      ts: this.clock(),
      ...(errorKind ? { errorKind } : {}),
    };
    this.options.tracker.record(record);
  }

  private onSuccess(
    candidate: Candidate,
    requestId: string,
    promptTokens: number,
    completionTokens: number,
    startedAt: number,
  ): void {
    const { account } = candidate;
    const latencyMs = Math.max(0, this.clock() - startedAt);
    this.breaker.onSuccess(account.id);
    this.recordUsage(candidate, requestId, 'success', promptTokens, completionTokens, latencyMs);
    const current = this.options.accounts.get(account.id);
    if (current && (current.status === 'cooldown' || current.lastError || current.cooldownUntil)) {
      this.emitAccount(
        this.options.accounts.update(account.id, {
          status: 'active',
          cooldownUntil: null,
          lastError: null,
        }),
      );
    }
    this.options.events.emit({
      type: 'request.completed',
      requestId,
      model: candidate.model,
      accountId: account.id,
      provider: candidate.provider,
      promptTokens,
      completionTokens,
      latencyMs,
    });
  }

  /** The caller aborted: record the attempt as cancelled without touching cooldowns. */
  private onCancelled(
    candidate: Candidate,
    requestId: string,
    startedAt: number,
    tokens: { prompt: number; completion: number } = { prompt: 0, completion: 0 },
  ): void {
    const latencyMs = Math.max(0, this.clock() - startedAt);
    this.breaker.onCancel(candidate.account.id);
    this.recordUsage(
      candidate,
      requestId,
      'cancelled',
      tokens.prompt,
      tokens.completion,
      latencyMs,
    );
  }

  private onFailure(
    candidate: Candidate,
    requestId: string,
    error: ProviderError,
    startedAt: number,
    tokens: { prompt: number; completion: number } = { prompt: 0, completion: 0 },
  ): void {
    const { account } = candidate;
    const latencyMs = Math.max(0, this.clock() - startedAt);
    const rateLimited = error.kind === 'rate_limit' || error.kind === 'quota_exhausted';
    this.recordUsage(
      candidate,
      requestId,
      rateLimited ? 'rate_limited' : 'error',
      tokens.prompt,
      tokens.completion,
      latencyMs,
      error.kind,
    );
    this.options.events.emit({
      type: 'request.failed',
      requestId,
      accountId: account.id,
      provider: candidate.provider,
      error: {
        kind: error.kind,
        message: error.message,
        ...(error.status !== undefined ? { status: error.status } : {}),
      },
    });
    if (BREAKER_KINDS.has(error.kind)) this.breaker.onFailure(account.id);

    if (error.kind === 'auth') {
      this.emitAccount(
        this.options.accounts.update(account.id, { status: 'error', lastError: error.message }),
      );
    } else if (error.failover && error.kind !== 'context_length') {
      // context_length is the prompt's fault, not the account's: fail over without cooldown.
      const cooldownMs = error.retryAfterMs ?? this.config.routing.cooldownMs;
      const until = new Date(this.clock() + cooldownMs).toISOString();
      this.emitAccount(
        this.options.accounts.update(account.id, {
          status: 'cooldown',
          cooldownUntil: until,
          lastError: error.message,
        }),
      );
    }
  }

  /**
   * Try ranked candidates in order until `attempt` succeeds, failing over on
   * failover-eligible errors up to `routing.maxFailovers` hops.
   */
  private async execute<T>(
    req: ChatRequest,
    options: RouteRequestOptions,
    attempt: (candidate: Candidate, ctx: ProviderCallContext, request: ChatRequest) => Promise<T>,
  ): Promise<{
    value: T;
    candidate: Candidate;
    meta: RoutingMeta;
    startedAt: number;
    estimate: number;
  }> {
    const requestId = options.requestId ?? newId('req');
    const estimate = estimateTokens(req.messages);
    const plan = this.plan(req, estimate);
    if (plan.candidates.length === 0) throw this.noCandidateError(req, plan, requestId);

    const maxAttempts = this.config.routing.maxFailovers + 1;
    const cooled = new Set<string>();
    const errors: ProviderError[] = [];
    let attempts = 0;
    let failovers = 0;

    const usable = (c: Candidate) => !cooled.has(c.account.id) && this.breaker.allow(c.account.id);

    for (let i = 0; i < plan.candidates.length && attempts < maxAttempts; i++) {
      const candidate = plan.candidates[i]!;
      if (!usable(candidate)) continue;
      attempts++;
      const { account } = candidate;
      this.breaker.onAttempt(account.id);
      this.options.events.emit({
        type: 'request.started',
        requestId,
        model: candidate.model,
        accountId: account.id,
        provider: candidate.provider,
      });
      const startedAt = this.clock();
      try {
        const ctx = this.contextFor(account, options.signal);
        const value = await attempt(candidate, ctx, { ...req, model: candidate.model });
        return {
          value,
          candidate,
          startedAt,
          estimate,
          meta: {
            requestId,
            accountId: account.id,
            provider: candidate.provider,
            model: candidate.model,
            failovers,
          },
        };
      } catch (err) {
        const error = toProviderError(err, account);
        if (options.signal?.aborted) {
          // The client went away: not the account's fault, so no cooldown and no failover.
          this.onCancelled(candidate, requestId, startedAt);
          throw error;
        }
        this.onFailure(candidate, requestId, error, startedAt);
        if (!error.failover) throw error;
        errors.push(error);
        if (error.kind !== 'context_length') cooled.add(account.id);
        const next = attempts < maxAttempts ? plan.candidates.slice(i + 1).find(usable) : undefined;
        this.options.events.emit({
          type: 'router.failover',
          requestId,
          fromAccountId: account.id,
          toAccountId: next?.account.id ?? null,
          reason: error.kind,
        });
        if (next) failovers++;
      }
    }

    const lastError = errors.at(-1);
    const allRateLimited =
      errors.length > 0 &&
      errors.every((e) => e.kind === 'rate_limit' || e.kind === 'quota_exhausted');
    if (errors.length === 0) {
      throw new RouterError('no_capacity', `Every account for "${req.model}" is unavailable`, {
        requestId,
      });
    }
    throw new RouterError(
      allRateLimited ? 'rate_limited' : 'upstream_failed',
      `All ${errors.length} attempt(s) for "${req.model}" failed${lastError ? `: ${lastError.message}` : ''}`,
      { requestId, failovers, ...(lastError ? { lastError } : {}) },
    );
  }

  /** Non-streaming completion with hot failover. */
  async complete(req: ChatRequest, options: RouteRequestOptions = {}): Promise<CompletionResult> {
    const { value, candidate, meta, startedAt, estimate } = await this.execute(
      req,
      options,
      (c, ctx, request) =>
        this.options.providers.get(c.provider)!.complete({ ...request, stream: false }, ctx),
    );
    const usage = value.usage;
    const hasUsage = usage && (usage.prompt_tokens > 0 || usage.completion_tokens > 0);
    const promptTokens = hasUsage ? usage.prompt_tokens : estimate;
    const completionTokens = hasUsage
      ? usage.completion_tokens
      : countTextTokens(value.choices.map((c) => messageText(c.message)).join(''));
    this.onSuccess(candidate, meta.requestId, promptTokens, completionTokens, startedAt);
    return { completion: value, meta };
  }

  /**
   * Streaming completion. Failover happens only until the first chunk arrives; the
   * returned promise resolves once a provider has produced it (or ended cleanly).
   */
  async stream(req: ChatRequest, options: RouteRequestOptions = {}): Promise<StreamResult> {
    const { value, candidate, meta, startedAt, estimate } = await this.execute(
      req,
      options,
      async (c, ctx, request) => {
        const iterator = this.options.providers
          .get(c.provider)!
          .stream({ ...request, stream: true }, ctx)
          [Symbol.asyncIterator]();
        const first = await iterator.next();
        return { iterator, first };
      },
    );
    return {
      meta,
      chunks: this.relay(
        value.iterator,
        value.first,
        candidate,
        meta,
        startedAt,
        estimate,
        options.signal,
      ),
    };
  }

  private async *relay(
    iterator: AsyncIterator<ChatCompletionChunk>,
    first: IteratorResult<ChatCompletionChunk>,
    candidate: Candidate,
    meta: RoutingMeta,
    startedAt: number,
    estimate: number,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk> {
    let text = '';
    let upstreamUsage: ChatCompletionChunk['usage'];
    let done = first.done === true;
    let failed = false;
    const track = (chunk: ChatCompletionChunk) => {
      if (chunk.usage) upstreamUsage = chunk.usage;
      for (const choice of chunk.choices) text += messageText(choice.delta);
    };
    const tokens = () => {
      const has =
        upstreamUsage && (upstreamUsage.prompt_tokens > 0 || upstreamUsage.completion_tokens > 0);
      return has && upstreamUsage
        ? { prompt: upstreamUsage.prompt_tokens, completion: upstreamUsage.completion_tokens }
        : { prompt: estimate, completion: countTextTokens(text) };
    };

    try {
      if (!first.done) {
        track(first.value);
        yield first.value;
      }
      while (!done) {
        const next = await iterator.next();
        if (next.done) {
          done = true;
          break;
        }
        track(next.value);
        yield next.value;
      }
    } catch (err) {
      failed = true;
      const error = toProviderError(err, candidate.account);
      if (signal?.aborted) {
        // Client disconnect or Esc in the TUI mid-stream: record what was used, blame no one.
        this.onCancelled(candidate, meta.requestId, startedAt, tokens());
      } else {
        this.onFailure(candidate, meta.requestId, error, startedAt, tokens());
      }
      throw error;
    } finally {
      if (!done && !failed) {
        // The consumer stopped early (client disconnect): release the upstream stream.
        try {
          await iterator.return?.();
        } catch {
          // Ignore cleanup errors from the provider.
        }
      }
      if (!failed) {
        const { prompt, completion } = tokens();
        this.onSuccess(candidate, meta.requestId, prompt, completion, startedAt);
      }
    }
  }

  /**
   * Models for `GET /v1/models`: every model of every usable account (allow-list, else the
   * provider's `listModels`), plus `davecode/<route>` for each route and the default route.
   */
  async listModels(): Promise<ModelInfo[]> {
    const { routing, experimental } = this.config;
    const accounts = this.options.accounts
      .list()
      .filter(
        (a) =>
          a.enabled &&
          (experimental.geminiWeb || !EXPERIMENTAL_PROVIDER_KINDS.includes(a.provider)),
      );
    const lists = await Promise.all(
      accounts.map(async (account): Promise<ModelInfo[]> => {
        const created = Math.floor(Date.parse(account.createdAt) / 1000) || 0;
        const listed = configuredModels(account);
        if (listed) {
          return listed.map((id) => ({ id, object: 'model', created, owned_by: account.provider }));
        }
        const provider = this.options.providers.get(account.provider);
        if (!provider) return [];
        try {
          return await provider.listModels(this.contextFor(account));
        } catch {
          return [];
        }
      }),
    );
    const models = new Map<string, ModelInfo>();
    for (const model of lists.flat()) if (!models.has(model.id)) models.set(model.id, model);
    const routeNames = routing.routes.map((r) => r.name);
    if (!routeNames.includes(routing.defaultRoute)) routeNames.unshift(routing.defaultRoute);
    for (const name of routeNames) {
      const id = `davecode/${name}`;
      models.set(id, { id, object: 'model', created: 0, owned_by: 'davecode' });
    }
    return [...models.values()];
  }
}
