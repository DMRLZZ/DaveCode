import { ApiError, type DaveClient, type RunnerAction } from './api';
import type { StreamHandlers } from './events';
import {
  ACCOUNT_SEEDS,
  MOCK_ARCHITECTURE,
  MOCK_ROUTES,
  type MockAccountSeed,
  mockState,
  mockTasks,
  ROUTE_MIX,
} from './mock-data';
import type {
  Account,
  AccountCreate,
  AccountPatch,
  AccountUsage,
  BrainResponse,
  DaveEvent,
  HealthResponse,
  LogLevel,
  ModelInfo,
  ProviderErrorKind,
  QuotaWindow,
  RouteTarget,
  RunnerState,
  RunnerStatus,
  TaskNode,
  TasksResponse,
  TimeseriesBucket,
  UsageRecord,
  WindowUsage,
} from './types';

/**
 * In-browser simulation of a busy DaveCode gateway, used when the gateway is unreachable or
 * with `?mock=1`. It implements the same DaveClient contract as the HTTP client and emits the
 * same events: requests with occasional 429 → failover chains, rising quota utilization,
 * cooldowns, and an autonomous runner walking the task graph with live logs.
 */

const MINUTE = 60_000;
const BACKPRESSURE = 0.85;
const SHIFT = 0.9;
const MAX_FAILOVERS = 4;

/** Small, fast, seedable PRNG so generated history is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface MockOptions {
  seed?: number;
  /** Clock source (tests pass a fixed clock). */
  now?: () => number;
  /** Simulate a gateway without the autonomous engine (`501 runner_unavailable`). */
  runnerAvailable?: boolean;
  /** Value reported for `experimental.geminiWeb` in /api/health. */
  geminiWeb?: boolean;
  /** Artificial response latency so loading states are visible. */
  latency?: boolean;
}

interface Attempt {
  account: Account;
  target: RouteTarget;
  ok: boolean;
  errorKind?: ProviderErrorKind;
  status?: number;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
}

interface RunnerStep {
  delay: number;
  run: () => void;
}

/** A DaveEvent whose `ts` is optional (filled with the engine clock). */
type EventInput = DaveEvent extends infer E
  ? E extends DaveEvent
    ? Omit<E, 'ts'> & { ts?: number }
    : never
  : never;

const ERROR_MESSAGES: Partial<Record<ProviderErrorKind, [number, string]>> = {
  rate_limit: [429, 'Rate limited by upstream (Retry-After: 45)'],
  quota_exhausted: [429, '5h usage window exhausted for this account'],
  unavailable: [503, 'Upstream overloaded, try again shortly'],
  timeout: [504, 'Upstream did not answer within 60s'],
};

const TASK_FILES: Record<string, string[]> = {
  'p2-router': [
    'packages/core/src/router/select.ts',
    'packages/core/src/router/failover.ts',
    'packages/core/src/router/circuit-breaker.ts',
    'packages/core/src/router/select.test.ts',
  ],
  'p1-gateway': [
    'packages/server/src/app.ts',
    'packages/server/src/routes/v1.ts',
    'packages/server/src/routes/api.ts',
    'packages/server/src/sse.ts',
  ],
  'p4-runner': [
    'packages/core/src/autonomous/runner.ts',
    'packages/core/src/autonomous/validator.ts',
    'packages/core/src/autonomous/git.ts',
    'packages/core/src/autonomous/runner.test.ts',
  ],
  'p5-cli': [
    'packages/cli/src/commands/start.ts',
    'packages/cli/src/commands/run.ts',
    'packages/cli/src/tui/App.tsx',
  ],
};

/** How many validation failures each task hits before it passes (3 = task fails). */
const TASK_FAILURES: Record<string, number> = {
  'p2-router': 1,
  'p1-gateway': 0,
  'p4-runner': 2,
  'p5-cli': 1,
};

export class MockEngine implements DaveClient {
  readonly mode = 'mock' as const;

  private readonly rng: () => number;
  private readonly clock: () => number;
  private readonly t0: number;
  private readonly opts: Required<Omit<MockOptions, 'now' | 'seed'>>;
  private readonly seeds = new Map<string, MockAccountSeed>();
  private accounts: Account[] = [];
  private records: UsageRecord[] = [];
  private taskList: TaskNode[];
  private runnerStatus: RunnerStatus;
  private readonly buffer: DaveEvent[] = [];
  private readonly subscribers = new Set<StreamHandlers>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private running = false;
  private stopGrace: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;
  private runnerQueue: RunnerStep[] = [];
  private runnerTimer: ReturnType<typeof setTimeout> | undefined;
  private runnerPending: RunnerStep | undefined;
  private initialResumed = false;
  private pausedFrom: RunnerState | undefined;
  private readonly pressureLogged = new Map<string, number>();

  constructor(options: MockOptions = {}) {
    this.rng = mulberry32(options.seed ?? 0xda7ec0de);
    this.clock = options.now ?? Date.now;
    this.opts = {
      runnerAvailable: options.runnerAvailable ?? true,
      geminiWeb: options.geminiWeb ?? false,
      latency: options.latency ?? true,
    };
    this.t0 = this.clock();

    for (const seed of ACCOUNT_SEEDS) {
      this.seeds.set(seed.account.id, seed);
      this.accounts.push({
        ...seed.account,
        status: seed.account.status ?? 'active',
        createdAt: new Date(this.t0 - 12 * 86_400_000).toISOString(),
        updatedAt: new Date(this.t0 - 3_600_000).toISOString(),
      });
    }
    this.taskList = mockTasks(this.t0);
    this.runnerStatus = {
      state: 'implementing',
      taskId: 'p2-router',
      repairCycle: 1,
      startedAt: new Date(this.t0 - 4.2 * MINUTE).toISOString(),
    };
    this.generateHistory();
    if (this.opts.runnerAvailable) this.seedRunnerHistory();
  }

  // -------------------------------------------------------------------------
  // DaveClient
  // -------------------------------------------------------------------------

  health(): Promise<HealthResponse> {
    return this.respond(() => ({
      status: 'ok',
      version: '0.1.0',
      uptimeSec: Math.round((this.clock() - this.t0) / 1000) + 3 * 3600 + 17 * 60,
      experimental: { geminiWeb: this.opts.geminiWeb, multiAccountRotation: false },
    }));
  }

  listAccounts(): Promise<Account[]> {
    return this.respond(() => this.accounts);
  }

  createAccount(body: AccountCreate): Promise<Account> {
    return this.respond(() => {
      if (!body.label?.trim()) throw new ApiError(400, 'invalid_body', 'label: must not be empty');
      if (body.provider === 'gemini-web' && !this.opts.geminiWeb) {
        throw new ApiError(
          400,
          'experimental_disabled',
          'gemini-web requires experimental.geminiWeb = true in config.json',
        );
      }
      const now = new Date(this.clock()).toISOString();
      // The secret is deliberately discarded: the mock never stores or echoes it.
      const account: Account = {
        id: `acc_${body.provider.replace(/[^a-z]/g, '')}_${Math.floor(this.rng() * 1e6).toString(36)}`,
        provider: body.provider,
        label: body.label.trim(),
        enabled: true,
        priority: body.priority ?? 100,
        weight: body.weight ?? 1,
        limits: body.limits ?? {},
        config: body.config ?? {},
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
      this.accounts.push(account);
      this.seeds.set(account.id, {
        account,
        curve5h: { from: 0, to: 0.05 },
        curve24h: { from: 0, to: 0.02 },
        latency: [700, 10],
        failRate: 0.01,
      });
      this.emit({ type: 'account.updated', account });
      this.log('info', 'accounts', `Account ${account.id} (${account.provider}) added`);
      return account;
    });
  }

  updateAccount(id: string, patch: AccountPatch): Promise<Account> {
    return this.respond(() => {
      const current = this.findAccount(id);
      const enabled = patch.enabled ?? current.enabled;
      const next: Account = {
        ...current,
        ...(patch.label !== undefined && { label: patch.label }),
        ...(patch.priority !== undefined && { priority: patch.priority }),
        ...(patch.weight !== undefined && { weight: patch.weight }),
        ...(patch.limits !== undefined && { limits: patch.limits }),
        ...(patch.config !== undefined && { config: patch.config }),
        enabled,
        status: !enabled ? 'disabled' : current.status === 'disabled' ? 'active' : current.status,
        updatedAt: new Date(this.clock()).toISOString(),
      };
      if (!enabled) {
        delete next.cooldownUntil;
      }
      this.replaceAccount(next);
      return next;
    });
  }

  deleteAccount(id: string): Promise<void> {
    return this.respond(() => {
      this.findAccount(id);
      this.accounts = this.accounts.filter((a) => a.id !== id);
      this.emit({ type: 'account.removed', accountId: id });
      return undefined;
    });
  }

  usage(): Promise<AccountUsage[]> {
    return this.respond(() => this.accounts.map((a) => this.accountUsage(a, this.clock())));
  }

  timeseries(minutes = 60, bucketSec = 60): Promise<TimeseriesBucket[]> {
    return this.respond(() => this.buildTimeseries(minutes, bucketSec));
  }

  requests(limit = 100): Promise<UsageRecord[]> {
    return this.respond(() => this.records.slice(-limit).reverse());
  }

  routes() {
    return this.respond(() => ({ defaultRoute: 'auto', routes: MOCK_ROUTES }));
  }

  tasks(): Promise<TasksResponse> {
    return this.respond(() => ({
      project: { root: 'C:/Users/dev/code/DaveCode', name: 'DaveCode' },
      graph: { version: 1 as const, tasks: this.taskList },
    }));
  }

  brain(): Promise<BrainResponse> {
    return this.respond(() => ({
      state: mockState(this.taskList, this.clock()),
      architecture: MOCK_ARCHITECTURE,
    }));
  }

  runner(): Promise<RunnerStatus> {
    return this.respond(() => {
      this.assertRunner();
      return this.runnerStatus;
    });
  }

  runnerAction(action: RunnerAction): Promise<RunnerStatus> {
    return this.respond(() => {
      this.assertRunner();
      const s = this.runnerStatus.state;
      if (action === 'pause') {
        if (s !== 'paused' && s !== 'idle' && s !== 'stopped') {
          this.pausedFrom = s;
          this.haltRunner();
          this.setRunner({ ...this.runnerStatus, state: 'paused' });
          this.runnerLog('warn', 'Paused by user. The current step resumes where it left off.');
        }
      } else if (action === 'start') {
        if (s === 'paused') {
          this.setRunner({ ...this.runnerStatus, state: this.pausedFrom ?? 'selecting' });
          this.pausedFrom = undefined;
          this.runnerLog('info', 'Resumed by user.');
          this.pumpRunner();
        } else if (s === 'idle' || s === 'stopped' || s === 'error') {
          this.runnerLog('info', 'Runner started.');
          this.runnerQueue = [];
          this.enqueueSelect(0);
          this.pumpRunner();
        }
      } else if (action === 'stop') {
        this.haltRunner();
        this.runnerQueue = [];
        const taskId = this.runnerStatus.taskId;
        if (taskId) {
          const task = this.taskList.find((t) => t.id === taskId);
          if (task && task.status === 'IN_PROGRESS') {
            this.updateTask({
              ...task,
              status: 'PENDING',
              notes: 'Run stopped by user; branch kept.',
            });
          }
        }
        this.setRunner({ state: 'stopped' });
        this.runnerLog('warn', 'Stopped by user. Work in progress stays on its task branch.');
      }
      return this.runnerStatus;
    });
  }

  logs(limit = 200): Promise<DaveEvent[]> {
    return this.respond(() => this.buffer.slice(-limit));
  }

  models(): Promise<ModelInfo[]> {
    return this.respond(() => {
      const created = Math.floor(this.t0 / 1000);
      const out: ModelInfo[] = [];
      for (const acc of this.accounts.filter((a) => a.enabled)) {
        for (const m of this.modelsFor(acc)) {
          out.push({
            id: `${acc.provider}/${m}`,
            object: 'model',
            created,
            owned_by: acc.provider,
          });
        }
      }
      for (const r of MOCK_ROUTES) {
        out.push({ id: `davecode/${r.name}`, object: 'model', created, owned_by: 'davecode' });
      }
      return out;
    });
  }

  subscribe(handlers: StreamHandlers): () => void {
    this.subscribers.add(handlers);
    handlers.onStatus?.({ state: 'mock', attempt: 0, lastEventAt: this.clock() });
    // Like the real gateway: replay the recent buffer, then stream live.
    const replay = this.buffer.slice(-500);
    queueMicrotask(() => {
      if (!this.subscribers.has(handlers)) return;
      for (const e of replay) handlers.onEvent(e);
    });
    if (this.stopGrace) {
      clearTimeout(this.stopGrace);
      this.stopGrace = undefined;
    }
    this.start();
    return () => {
      this.subscribers.delete(handlers);
      if (this.subscribers.size === 0) {
        // Grace period: React StrictMode unsubscribes and resubscribes immediately.
        this.stopGrace = setTimeout(() => this.stop(), 1000);
      }
    };
  }

  // -------------------------------------------------------------------------
  // Simulation loop
  // -------------------------------------------------------------------------

  /** Start live simulation (idempotent). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleRequest();
    this.every(5000, () => {
      for (const a of this.accounts) {
        if (a.enabled)
          this.emit({ type: 'quota.updated', usage: this.accountUsage(a, this.clock()) });
      }
      this.checkPressure();
    });
    if (this.opts.runnerAvailable) {
      if (!this.initialResumed && this.runnerStatus.state === 'implementing') {
        this.initialResumed = true;
        this.resumeInitialTask();
      }
      if (this.runnerStatus.state !== 'paused') this.pumpRunner();
    }
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.haltRunner();
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.running) fn();
    }, ms);
    this.timers.add(t);
  }

  private every(ms: number, fn: () => void): void {
    const loop = () => {
      fn();
      this.later(ms, loop);
    };
    this.later(ms, loop);
  }

  /** Requests per minute, shaped like a real working session. */
  private rate(ts: number): number {
    const m = ts / MINUTE;
    const wave = 11 + 4 * Math.sin(m / 9) + 2.5 * Math.sin(m / 3.3);
    return Math.max(3, wave);
  }

  private scheduleRequest(): void {
    const meanGap = MINUTE / this.rate(this.clock());
    const gap = Math.min(meanGap * 3, -Math.log(1 - this.rng()) * meanGap);
    this.later(Math.max(250, gap), () => {
      this.runLiveRequest();
      this.scheduleRequest();
    });
  }

  private runLiveRequest(): void {
    const plan = this.planRequest(this.clock(), true);
    if (!plan) return;
    const requestId = this.nextId('req');
    const { candidates } = plan;
    const step = (index: number) => {
      const candidate = candidates[index];
      if (!candidate) return;
      const { account, target } = candidate;
      this.emit({
        type: 'request.started',
        requestId,
        model: target.model,
        accountId: account.id,
        provider: account.provider,
      });
      const attempt = this.rollAttempt(account, target, this.clock(), true);
      this.later(attempt.latencyMs, () => {
        const ts = this.clock();
        this.pushRecord(requestId, attempt, ts);
        if (attempt.ok) {
          this.emit({
            type: 'request.completed',
            requestId,
            model: target.model,
            accountId: account.id,
            provider: account.provider,
            promptTokens: attempt.promptTokens,
            completionTokens: attempt.completionTokens,
            latencyMs: attempt.latencyMs,
          });
          this.emit({ type: 'quota.updated', usage: this.accountUsage(account, ts) });
          return;
        }
        const kind = attempt.errorKind ?? 'unknown';
        const [status, message] = ERROR_MESSAGES[kind] ?? [500, 'Upstream error'];
        this.emit({
          type: 'request.failed',
          requestId,
          accountId: account.id,
          provider: account.provider,
          error: { kind, message, status },
        });
        if (kind === 'rate_limit' || kind === 'quota_exhausted' || kind === 'unavailable') {
          this.startCooldown(account, kind === 'unavailable' ? 20 : 45);
        }
        const next =
          index + 1 < candidates.length && index < MAX_FAILOVERS
            ? candidates[index + 1]
            : undefined;
        this.emit({
          type: 'router.failover',
          requestId,
          fromAccountId: account.id,
          toAccountId: next?.account.id ?? null,
          reason: kind,
        });
        if (next) this.later(20 + this.rng() * 40, () => step(index + 1));
      });
    };
    step(0);
  }

  // -------------------------------------------------------------------------
  // Request planning (shared by history generation and live traffic)
  // -------------------------------------------------------------------------

  private pickRoute(): string {
    let r = this.rng();
    for (const [name, share] of ROUTE_MIX) {
      if (r < share) return name;
      r -= share;
    }
    return 'auto';
  }

  private candidatesFor(target: RouteTarget, live: boolean): Account[] {
    return this.accounts.filter((a) => {
      if (!a.enabled || a.status === 'disabled' || a.status === 'error') return false;
      if (live && a.status === 'cooldown') return false;
      if (target.accountId) return a.id === target.accountId;
      if (a.provider !== target.provider) return false;
      return this.modelsFor(a).includes(target.model) || this.modelsFor(a).length === 0;
    });
  }

  /** Ordered failover candidates for a new request; the first is chosen by weighted headroom. */
  private planRequest(
    ts: number,
    live: boolean,
  ): { model: string; candidates: { account: Account; target: RouteTarget }[] } | null {
    const route = MOCK_ROUTES.find((r) => r.name === this.pickRoute()) ?? MOCK_ROUTES[0];
    if (!route) return null;
    const options: { account: Account; target: RouteTarget; weight: number }[] = [];
    route.targets.forEach((target, i) => {
      for (const account of this.candidatesFor(target, live)) {
        const util = this.util5h(account, ts);
        const headroom = util >= SHIFT ? 0.12 : util >= BACKPRESSURE ? 0.45 : 1;
        const positional = [5, 3, 1.4, 0.7][i] ?? 0.5;
        options.push({ account, target, weight: positional * account.weight * headroom });
      }
    });
    if (options.length === 0) return null;
    const total = options.reduce((s, o) => s + o.weight, 0);
    let r = this.rng() * total;
    let firstIndex = 0;
    for (let i = 0; i < options.length; i++) {
      r -= options[i]?.weight ?? 0;
      if (r <= 0) {
        firstIndex = i;
        break;
      }
    }
    const first = options[firstIndex];
    if (!first) return null;
    const rest = options.filter(
      (_, i) => i !== firstIndex && options[i]?.account.id !== first.account.id,
    );
    return {
      model: first.target.model,
      candidates: [first, ...rest].map(({ account, target }) => ({ account, target })),
    };
  }

  private rollAttempt(account: Account, target: RouteTarget, ts: number, live: boolean): Attempt {
    const seed = this.seeds.get(account.id);
    const [base, perToken] = seed?.latency ?? [700, 10];
    const fast =
      target.model.includes('mini') ||
      target.model.includes('haiku') ||
      target.model.includes('scout');
    const heavy = target.model.includes('opus') || target.model.includes('pro');
    const promptTokens = Math.round((fast ? 900 : 2400) * Math.exp(this.rng() * 1.6));
    const completionTokens = Math.round(
      (fast ? 80 : heavy ? 700 : 300) * Math.exp(this.rng() * 1.1),
    );
    const latencyMs = Math.round(
      (base + completionTokens * perToken * (fast ? 0.35 : 0.6)) * (0.75 + this.rng() * 0.5),
    );
    const util = this.util5h(account, ts);
    let pFail = seed?.failRate ?? 0.01;
    if (util >= SHIFT) pFail += 0.5;
    else if (util >= BACKPRESSURE) pFail += 0.16;
    if (!live) pFail *= 0.8;
    if (this.rng() < pFail) {
      const kind: ProviderErrorKind =
        account.provider === 'openai-compatible'
          ? 'timeout'
          : util >= BACKPRESSURE || this.rng() < 0.7
            ? 'rate_limit'
            : 'unavailable';
      return {
        account,
        target,
        ok: false,
        errorKind: kind,
        status: ERROR_MESSAGES[kind]?.[0],
        latencyMs: Math.round(
          kind === 'timeout' ? 6000 + this.rng() * 2000 : 180 + this.rng() * 400,
        ),
        promptTokens: 0,
        completionTokens: 0,
      };
    }
    return { account, target, ok: true, latencyMs, promptTokens, completionTokens };
  }

  private pushRecord(requestId: string, a: Attempt, ts: number): void {
    this.records.push({
      id: this.nextId('use'),
      requestId,
      accountId: a.account.id,
      provider: a.account.provider,
      model: a.target.model,
      promptTokens: a.promptTokens,
      completionTokens: a.completionTokens,
      latencyMs: a.latencyMs,
      status: a.ok ? 'success' : a.errorKind === 'rate_limit' ? 'rate_limited' : 'error',
      ...(a.errorKind && { errorKind: a.errorKind }),
      ts,
    });
    const cutoff = this.clock() - 2 * 3_600_000;
    if (this.records.length > 4000 || (this.records[0]?.ts ?? cutoff) < cutoff) {
      this.records = this.records.filter((r) => r.ts >= cutoff).slice(-4000);
    }
  }

  private generateHistory(): void {
    const start = this.t0 - 62 * MINUTE;
    const eventsFrom = this.t0 - 6 * MINUTE;
    for (let m = start; m < this.t0; m += MINUTE) {
      const burst = m > this.t0 - 24 * MINUTE && m < this.t0 - 18 * MINUTE ? 7 : 0;
      const n = Math.round(this.rate(m) + burst + (this.rng() - 0.5) * 4);
      for (let i = 0; i < n; i++) {
        const ts0 = m + this.rng() * MINUTE;
        if (ts0 >= this.t0) continue;
        const plan = this.planRequest(ts0, false);
        if (!plan) continue;
        const requestId = this.nextId('req');
        let t = ts0;
        for (let k = 0; k < plan.candidates.length && k <= MAX_FAILOVERS; k++) {
          const c = plan.candidates[k];
          if (!c) break;
          const attempt = this.rollAttempt(c.account, c.target, t, false);
          const end = t + attempt.latencyMs;
          if (end >= this.t0) break;
          this.pushRecord(requestId, attempt, end);
          if (ts0 >= eventsFrom)
            this.bufferChainEvents(requestId, attempt, t, end, plan.candidates[k + 1]?.account);
          t = end + 25;
          if (attempt.ok) break;
        }
      }
    }
    this.records.sort((a, b) => a.ts - b.ts);
    this.buffer.sort((a, b) => a.ts - b.ts);
  }

  private bufferChainEvents(
    requestId: string,
    a: Attempt,
    startTs: number,
    endTs: number,
    next: Account | undefined,
  ): void {
    const base = { requestId, accountId: a.account.id, provider: a.account.provider };
    this.buffer.push({ type: 'request.started', ...base, model: a.target.model, ts: startTs });
    if (a.ok) {
      this.buffer.push({
        type: 'request.completed',
        ...base,
        model: a.target.model,
        promptTokens: a.promptTokens,
        completionTokens: a.completionTokens,
        latencyMs: a.latencyMs,
        ts: endTs,
      });
      return;
    }
    const kind = a.errorKind ?? 'unknown';
    const [status, message] = ERROR_MESSAGES[kind] ?? [500, 'Upstream error'];
    this.buffer.push({
      type: 'request.failed',
      ...base,
      error: { kind, message, status },
      ts: endTs,
    });
    this.buffer.push({
      type: 'router.failover',
      requestId,
      fromAccountId: a.account.id,
      toAccountId: next?.id ?? null,
      reason: kind,
      ts: endTs + 1,
    });
  }

  // -------------------------------------------------------------------------
  // Quotas
  // -------------------------------------------------------------------------

  private curve(c: { from: number; to: number }, ts: number): number {
    const elapsed = Math.max(0, ts - this.t0) / 1000;
    const eased = 1 - Math.exp(-(elapsed + 20) / 260);
    const wobble = Math.sin(ts / 23_000) * 0.004;
    return Math.max(0, c.from + (c.to - c.from) * eased + (c.to > 0 ? wobble : 0));
  }

  private util5h(account: Account, ts: number): number {
    const seed = this.seeds.get(account.id);
    if (!seed || (!account.limits.tokens5h && !account.limits.requests5h)) return 0;
    return this.curve(seed.curve5h, ts);
  }

  private accountUsage(account: Account, ts: number): AccountUsage {
    const seed = this.seeds.get(account.id);
    const recent = this.records.filter(
      (r) => r.accountId === account.id && r.ts > ts - MINUTE && r.ts <= ts,
    );
    const hour = this.records.filter((r) => r.accountId === account.id && r.ts > ts - 60 * MINUTE);
    const sum = (rs: UsageRecord[]) =>
      rs.reduce((s, r) => s + r.promptTokens + r.completionTokens, 0);
    const l = account.limits;

    const oneMinTokens = sum(recent);
    const oneMin: WindowUsage = {
      window: '1m',
      tokens: oneMinTokens,
      requests: recent.length,
      ...(l.tpm !== undefined && { tokenLimit: l.tpm }),
      ...(l.rpm !== undefined && { requestLimit: l.rpm }),
      utilization: Math.max(l.tpm ? oneMinTokens / l.tpm : 0, l.rpm ? recent.length / l.rpm : 0),
    };

    const rolling = (
      window: QuotaWindow,
      tokenLimit: number | undefined,
      requestLimit: number | undefined,
      curve: { from: number; to: number } | undefined,
      fallbackMultiplier: number,
    ): WindowUsage => {
      if (!tokenLimit && !requestLimit) {
        return {
          window,
          tokens: Math.round(sum(hour) * fallbackMultiplier),
          requests: Math.round(hour.length * fallbackMultiplier),
          utilization: 0,
        };
      }
      const u = curve ? this.curve(curve, ts) : 0;
      return {
        window,
        tokens: Math.round(u * (tokenLimit ?? sum(hour) * fallbackMultiplier * 2)),
        requests: Math.round(
          requestLimit ? u * 0.92 * requestLimit : hour.length * fallbackMultiplier,
        ),
        ...(tokenLimit !== undefined && { tokenLimit }),
        ...(requestLimit !== undefined && { requestLimit }),
        utilization: u,
      };
    };

    return {
      accountId: account.id,
      windows: {
        '1m': oneMin,
        '5h': rolling('5h', l.tokens5h, l.requests5h, seed?.curve5h, 3.4),
        '24h': rolling('24h', l.tokensDaily, l.requestsDaily, seed?.curve24h, 9.5),
      },
    };
  }

  private checkPressure(): void {
    const ts = this.clock();
    for (const a of this.accounts) {
      const u = this.util5h(a, ts);
      const level = u >= SHIFT ? 2 : u >= BACKPRESSURE ? 1 : 0;
      const prev = this.pressureLogged.get(a.id) ?? 0;
      if (level > prev) {
        this.pressureLogged.set(a.id, level);
        if (level === 1) {
          this.log(
            'info',
            'router',
            `Backpressure: ${a.id} at ${(u * 100).toFixed(0)}% of its 5h window; weight smoothed down`,
          );
        } else {
          this.log(
            'warn',
            'router',
            `Quota shift: ${a.id} above 90% of its 5h window; routing to alternates`,
          );
        }
      }
    }
  }

  private startCooldown(account: Account, seconds: number): void {
    const current = this.accounts.find((a) => a.id === account.id);
    if (!current || current.status === 'cooldown') return;
    const until = this.clock() + seconds * 1000;
    this.replaceAccount({
      ...current,
      status: 'cooldown',
      cooldownUntil: new Date(until).toISOString(),
      lastError: ERROR_MESSAGES.rate_limit?.[1],
      updatedAt: new Date(this.clock()).toISOString(),
    });
    this.log(
      'warn',
      'router',
      `${account.id} cooling down for ${seconds}s after upstream ${seconds > 30 ? 429 : 503}`,
    );
    this.later(seconds * 1000, () => {
      const latest = this.accounts.find((a) => a.id === account.id);
      if (latest?.status !== 'cooldown') return;
      const { cooldownUntil: _cleared, ...rest } = latest;
      this.replaceAccount({
        ...rest,
        status: 'active',
        updatedAt: new Date(this.clock()).toISOString(),
      });
      this.log('info', 'router', `${account.id} back in rotation`);
    });
  }

  private buildTimeseries(minutes: number, bucketSec: number): TimeseriesBucket[] {
    const size = Math.max(1, bucketSec) * 1000;
    const now = this.clock();
    const end = Math.floor(now / size) * size;
    const start = end - (Math.ceil((minutes * MINUTE) / size) - 1) * size;
    const buckets: TimeseriesBucket[] = [];
    for (let ts = start; ts <= end; ts += size) {
      buckets.push({ ts, tokens: 0, requests: 0, byAccount: {} });
    }
    for (const r of this.records) {
      if (r.ts < start || r.ts > now || r.status !== 'success') continue;
      const b = buckets[Math.floor((r.ts - start) / size)];
      if (!b) continue;
      const tokens = r.promptTokens + r.completionTokens;
      b.tokens += tokens;
      b.requests += 1;
      const acc = b.byAccount[r.accountId] ?? { tokens: 0, requests: 0 };
      acc.tokens += tokens;
      acc.requests += 1;
      b.byAccount[r.accountId] = acc;
    }
    return buckets;
  }

  // -------------------------------------------------------------------------
  // Autonomous runner simulation
  // -------------------------------------------------------------------------

  private assertRunner(): void {
    if (!this.opts.runnerAvailable) {
      throw new ApiError(
        501,
        'runner_unavailable',
        'The autonomous runner is not available in this gateway (started with --no-runner).',
      );
    }
  }

  private setRunner(status: RunnerStatus): void {
    this.runnerStatus = status;
    this.emit({ type: 'runner.status', status });
  }

  private runnerLog(level: LogLevel, message: string, ts?: number): void {
    const taskId = this.runnerStatus.taskId;
    const e: DaveEvent = {
      type: 'runner.log',
      level,
      message,
      ...(taskId && { taskId }),
      ts: ts ?? this.clock(),
    };
    if (ts !== undefined) this.buffer.push(e);
    else this.emit(e);
  }

  /** Cancel the scheduled step but keep it at the head of the queue so it can resume. */
  private haltRunner(): void {
    if (this.runnerTimer) clearTimeout(this.runnerTimer);
    this.runnerTimer = undefined;
    if (this.runnerPending) this.runnerQueue.unshift(this.runnerPending);
    this.runnerPending = undefined;
  }

  private pumpRunner(): void {
    if (this.runnerTimer || !this.running) return;
    const next = this.runnerQueue.shift();
    if (!next) return;
    this.runnerPending = next;
    this.runnerTimer = setTimeout(() => {
      this.runnerTimer = undefined;
      this.runnerPending = undefined;
      next.run();
      this.pumpRunner();
    }, next.delay);
  }

  private q(delay: number, run: () => void): void {
    this.runnerQueue.push({ delay, run });
  }

  private updateTask(task: TaskNode): void {
    const next = { ...task, updatedAt: new Date(this.clock()).toISOString() };
    this.taskList = this.taskList.map((t) => (t.id === task.id ? next : t));
    this.emit({ type: 'task.updated', task: next });
  }

  private nextTask(): TaskNode | undefined {
    const done = new Set(this.taskList.filter((t) => t.status === 'SUCCESS').map((t) => t.id));
    return this.taskList
      .filter((t) => t.status === 'PENDING' && t.dependsOn.every((d) => done.has(d)))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
  }

  private enqueueSelect(delay: number): void {
    this.q(delay, () => {
      this.setRunner({ state: 'selecting', startedAt: new Date(this.clock()).toISOString() });
      this.runnerLog('info', 'Scanning TASK_GRAPH.json for unblocked tasks…');
    });
    this.q(1100, () => {
      const task = this.nextTask();
      if (!task) {
        const blocked = this.taskList.filter((t) => t.status === 'PENDING').length;
        this.runnerLog(
          'warn',
          blocked
            ? `No unblocked tasks: ${blocked} pending task(s) wait on a FAILED dependency (p2-codex-cli).`
            : 'Task graph complete. Nothing left to do.',
        );
        this.setRunner({ state: 'idle' });
        return;
      }
      this.updateTask({ ...task, status: 'IN_PROGRESS', attempts: (task.attempts ?? 0) + 1 });
      this.setRunner({
        state: 'preparing',
        taskId: task.id,
        repairCycle: 0,
        startedAt: new Date(this.clock()).toISOString(),
      });
      this.runnerLog('info', `Selected ${task.id} (priority ${task.priority ?? 0}): ${task.title}`);
      this.enqueueTask(task.id, 0);
    });
  }

  private enqueueTask(taskId: string, fromCycle: number): void {
    if (fromCycle === 0) {
      this.q(900, () => this.runnerLog('info', `$ git switch -c davecode/task-${taskId} main`));
      this.q(1200, () =>
        this.runnerLog(
          'debug',
          'Injected brain: STATE.md (2.3 KB), ARCHITECTURE.md (4.9 KB), 4 global preferences',
        ),
      );
    }
    this.enqueueImplement(taskId, fromCycle);
  }

  private enqueueImplement(taskId: string, cycle: number): void {
    const files = TASK_FILES[taskId] ?? ['src/index.ts'];
    this.q(1000, () => {
      this.setRunner({ ...this.runnerStatus, state: 'implementing', taskId, repairCycle: cycle });
      this.runnerLog(
        'info',
        `→ davecode/auto · claude-sonnet-5-5 via acc_claude_pro (${(8 + this.rng() * 9).toFixed(1)}K in)`,
      );
    });
    files.forEach((file, i) => {
      this.q(1400 + this.rng() * 1600, () => {
        if (i === 0) this.runnerLog('debug', `read ${files[files.length - 1] ?? file}`);
        const add = Math.round(20 + this.rng() * 160);
        const del = Math.round(this.rng() * 30);
        this.runnerLog('info', `edit ${file} (+${add} −${del})`);
      });
    });
    this.enqueueValidate(taskId, cycle);
  }

  private enqueueValidate(taskId: string, cycle: number): void {
    const failures = TASK_FAILURES[taskId] ?? 0;
    const fails = cycle < failures;
    this.q(1500, () => {
      this.setRunner({ ...this.runnerStatus, state: 'validating' });
      this.runnerLog('info', '$ pnpm lint');
    });
    this.q(1100, () => this.runnerLog('info', `✓ lint passed (${(0.6 + this.rng()).toFixed(1)}s)`));
    this.q(400, () => this.runnerLog('info', '$ pnpm typecheck'));
    this.q(2200, () =>
      this.runnerLog('info', `✓ typecheck passed (${(4 + this.rng() * 3).toFixed(1)}s)`),
    );
    this.q(400, () => this.runnerLog('info', '$ pnpm test'));
    if (fails) {
      this.q(2600, () => {
        this.runnerLog('error', '✗ 2 failed, 211 passed (8.1s)');
        this.runnerLog(
          'error',
          `  FAIL ${TASK_FILES[taskId]?.at(-1) ?? 'test'} > honours Retry-After given as an HTTP-date`,
        );
      });
      if (cycle + 1 >= 3) {
        this.q(900, () => {
          const task = this.taskList.find((t) => t.id === taskId);
          if (task)
            this.updateTask({ ...task, status: 'FAILED', notes: 'Failed after 3 repair cycles.' });
          this.runnerLog(
            'error',
            `${taskId} FAILED after 3 repair cycles; branch kept for review.`,
          );
        });
        this.enqueueSelect(2000);
        return;
      }
      this.q(900, () => {
        this.setRunner({ ...this.runnerStatus, state: 'repairing', repairCycle: cycle + 1 });
        this.runnerLog(
          'warn',
          `Repair cycle ${cycle + 1}/3: feeding 2 failing assertions and stderr back to the model`,
        );
      });
      this.q(1600, () =>
        this.runnerLog('info', '→ davecode/reasoning · claude-opus-5-5 via acc_anthropic_work'),
      );
      this.enqueueImplement(taskId, cycle + 1);
      return;
    }
    this.q(2800, () =>
      this.runnerLog('info', `✓ ${200 + Math.round(this.rng() * 40)} tests passed (8.4s)`),
    );
    this.q(900, () => {
      this.setRunner({ ...this.runnerStatus, state: 'merging' });
      this.runnerLog('info', `$ git merge --no-ff davecode/task-${taskId} → main`);
    });
    this.q(1400, () => {
      const task = this.taskList.find((t) => t.id === taskId);
      if (task) this.updateTask({ ...task, status: 'SUCCESS', notes: undefined });
      this.runnerLog('info', `✓ ${taskId} merged. STATE.md updated.`);
    });
    this.enqueueSelect(2500);
  }

  /** The demo opens mid-task: p2-router is implementing after one repair cycle. */
  private resumeInitialTask(): void {
    this.q(1500, () =>
      this.runnerLog('info', 'edit packages/core/src/router/failover.ts (+34 −9)'),
    );
    this.q(2200, () =>
      this.runnerLog('info', 'edit packages/core/src/router/select.test.ts (+12 −2)'),
    );
    this.enqueueValidate('p2-router', 1);
  }

  private seedRunnerHistory(): void {
    const at = (minAgo: number) => this.t0 - minAgo * MINUTE;
    const lines: [number, LogLevel, string][] = [
      [4.3, 'info', 'Scanning TASK_GRAPH.json for unblocked tasks…'],
      [
        4.25,
        'info',
        'Selected p2-router (priority 80): Router with balancing, backpressure, cooldowns and hot failover',
      ],
      [4.2, 'info', '$ git switch -c davecode/task-p2-router main'],
      [
        4.15,
        'debug',
        'Injected brain: STATE.md (2.3 KB), ARCHITECTURE.md (4.9 KB), 4 global preferences',
      ],
      [4.1, 'info', '→ davecode/auto · claude-sonnet-5-5 via acc_claude_pro (14.2K in)'],
      [3.9, 'info', 'edit packages/core/src/router/select.ts (+142 −8)'],
      [3.7, 'info', 'edit packages/core/src/router/failover.ts (+96 −0)'],
      [3.5, 'info', 'edit packages/core/src/router/circuit-breaker.ts (+61 −0)'],
      [3.3, 'info', 'edit packages/core/src/router/select.test.ts (+188 −0)'],
      [3.1, 'info', '$ pnpm lint'],
      [3.05, 'info', '✓ lint passed (1.1s)'],
      [3.0, 'info', '$ pnpm typecheck'],
      [2.9, 'info', '✓ typecheck passed (5.8s)'],
      [2.85, 'info', '$ pnpm test'],
      [2.7, 'error', '✗ 2 failed, 209 passed (8.3s)'],
      [
        2.69,
        'error',
        '  FAIL packages/core/src/router/select.test.ts > honours Retry-After given as an HTTP-date',
      ],
      [2.6, 'warn', 'Repair cycle 1/3: feeding 2 failing assertions and stderr back to the model'],
      [2.5, 'info', '→ davecode/reasoning · claude-opus-5-5 via acc_anthropic_work'],
      [2.0, 'info', 'edit packages/core/src/router/failover.ts (+21 −6)'],
    ];
    for (const [ago, level, message] of lines) {
      this.buffer.push({ type: 'runner.log', level, message, taskId: 'p2-router', ts: at(ago) });
    }
    this.buffer.push({
      type: 'runner.status',
      status: { ...this.runnerStatus },
      ts: at(2.4),
    });
    this.buffer.push({
      type: 'log',
      level: 'info',
      scope: 'gateway',
      message: 'Listening on http://127.0.0.1:4040 (dashboard at /)',
      ts: at(5.5),
    });
    this.buffer.sort((a, b) => a.ts - b.ts);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private emit(input: EventInput): void {
    const event = { ...input, ts: input.ts ?? this.clock() } as DaveEvent;
    this.buffer.push(event);
    if (this.buffer.length > 800) this.buffer.splice(0, this.buffer.length - 800);
    for (const s of this.subscribers) s.onEvent(event);
  }

  private log(level: LogLevel, scope: string, message: string): void {
    this.emit({ type: 'log', level, scope, message });
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    const hex = () =>
      Math.floor(this.rng() * 0xffffff)
        .toString(16)
        .padStart(6, '0');
    // Random-looking like real ids; the sequence suffix guarantees uniqueness.
    return `${prefix}_${hex()}${hex()}${this.seq.toString(36)}`;
  }

  private modelsFor(account: Account): string[] {
    const models = account.config.models;
    if (Array.isArray(models)) return models.filter((m): m is string => typeof m === 'string');
    if (account.provider === 'claude-cli') return ['claude-sonnet-5-5', 'claude-opus-5-5'];
    if (account.provider === 'gemini-web') return ['gemini-3-pro'];
    return [];
  }

  private findAccount(id: string): Account {
    const account = this.accounts.find((a) => a.id === id);
    if (!account) throw new ApiError(404, 'not_found', `Account ${id} not found`);
    return account;
  }

  private replaceAccount(account: Account): void {
    this.accounts = this.accounts.map((a) => (a.id === account.id ? account : a));
    this.emit({ type: 'account.updated', account });
  }

  private async respond<T>(fn: () => T): Promise<T> {
    if (this.opts.latency) {
      await new Promise((r) => setTimeout(r, 90 + Math.random() * 220));
    }
    return structuredClone(fn());
  }
}

let singleton: MockEngine | undefined;

/** Shared mock instance. `?runner=off` and `?geminiWeb=1` tweak it for demos. */
export function getMockClient(): MockEngine {
  if (!singleton) {
    const params =
      typeof window === 'undefined'
        ? new URLSearchParams()
        : new URLSearchParams(window.location.search || window.location.hash.split('?')[1]);
    singleton = new MockEngine({
      runnerAvailable: params.get('runner') !== 'off',
      geminiWeb: params.get('geminiWeb') === '1',
    });
  }
  return singleton;
}
