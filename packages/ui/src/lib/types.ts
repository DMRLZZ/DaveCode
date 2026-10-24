/**
 * Dashboard copy of the shared DaveCode contracts.
 *
 * SOURCE OF TRUTH: packages/core/src/types.ts and packages/core/src/events.ts, plus the
 * request/response envelopes in docs/API.md. The copy exists so the browser bundle never
 * pulls in Node-only code from @davecode/core. `src/lib/types.contract.ts` asserts that
 * every type below is identical to the core one; `pnpm --filter @davecode/ui typecheck`
 * fails on drift. Change core first, then mirror it here.
 */

export type { LoginProvider, LoginStatus, LoginUser } from '@davecode/core';

// ---------------------------------------------------------------------------
// Mirrored from packages/core/src/types.ts
// ---------------------------------------------------------------------------

export interface ModelInfo {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export type ProviderKind =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'openai-compatible'
  | 'claude-cli'
  | 'codex-cli'
  | 'gemini-cli'
  | 'gemini-web';

export const EXPERIMENTAL_PROVIDER_KINDS: readonly ProviderKind[] = ['gemini-web'];

export const SUBSCRIPTION_PROVIDER_KINDS: readonly ProviderKind[] = [
  'claude-cli',
  'codex-cli',
  'gemini-cli',
  'gemini-web',
];

export interface QuotaLimits {
  tpm?: number;
  rpm?: number;
  tokens5h?: number;
  requests5h?: number;
  tokensDaily?: number;
  requestsDaily?: number;
}

export type AccountStatus = 'active' | 'cooldown' | 'disabled' | 'error';

export interface SubscriptionPrice {
  amount: number;
  /** ISO 4217 code, e.g. "USD". */
  currency: string;
  period: 'month' | 'year';
}

/** Plan, payment and renewal details entered by the user. Dates: YYYY-MM-DD or ISO. */
export interface SubscriptionInfo {
  plan?: string;
  paidAt?: string;
  renewsAt?: string;
  price?: SubscriptionPrice;
  notes?: string;
}

export interface Account {
  id: string;
  provider: ProviderKind;
  label: string;
  enabled: boolean;
  /** Lower number = tried first. */
  priority: number;
  weight: number;
  limits: QuotaLimits;
  subscription?: SubscriptionInfo;
  /** Non-secret provider settings (baseUrl, models…). Secrets are never returned. */
  config: Record<string, unknown>;
  status: AccountStatus;
  cooldownUntil?: string;
  lastError?: string;
  /** Whether the keyring holds a secret for this account. The secret itself is never exposed. */
  hasSecret?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RouteTarget {
  provider: ProviderKind;
  model: string;
  accountId?: string;
}

export interface Route {
  name: string;
  description?: string;
  targets: RouteTarget[];
}

export type QuotaWindow = '1m' | '5h' | '24h';

export interface WindowUsage {
  window: QuotaWindow;
  tokens: number;
  requests: number;
  tokenLimit?: number;
  requestLimit?: number;
  /** max(tokens/tokenLimit, requests/requestLimit), 0 when unlimited. Range 0..1+. */
  utilization: number;
}

export interface AccountUsage {
  accountId: string;
  windows: Record<QuotaWindow, WindowUsage>;
}

export interface ReportedLimitsInput {
  tokensRemaining?: number;
  tokensLimit?: number;
  requestsRemaining?: number;
  requestsLimit?: number;
  resetAt?: string;
  exhausted?: boolean;
}

/** Rate-limit state as the provider reported it (headers or a limit error). */
export interface ReportedLimits extends ReportedLimitsInput {
  source: 'headers' | 'error';
  observedAt: string;
}

/** One account in `GET /api/budget`. */
export interface AccountBudget {
  accountId: string;
  label: string;
  provider: ProviderKind;
  enabled: boolean;
  subscription?: SubscriptionInfo;
  renewsInDays?: number;
  /** Remaining fraction 0..1 of the tightest known limit; null when unmetered. */
  remaining: number | null;
  tightestWindow?: QuotaWindow;
  usage: AccountUsage;
  reported?: ReportedLimits;
  available: boolean;
  unavailableReason?: string;
}

export interface BudgetSnapshot {
  generatedAt: string;
  accounts: AccountBudget[];
  /** Compact summary injected into agent prompts. */
  context: string;
}

export type ConnectionMethod = 'api-key' | 'cli-login' | 'browser';

export type ConnectionStatus = 'connected' | 'not_connected' | 'unknown';

/** `GET /api/accounts/:id/connection`. Never contains credentials. */
export interface AccountConnection {
  accountId: string;
  provider: ProviderKind;
  method: ConnectionMethod;
  status: ConnectionStatus;
  detail?: string;
  loginCommand?: string;
  checkedAt: string;
}

/** `POST /api/accounts/:id/connect`. */
export interface ConnectResult {
  connection: AccountConnection;
  launched: boolean;
  command: string;
  message: string;
}

/** `cancelled`: the client aborted (disconnect, Esc in the TUI); never counts against the account. */
export type UsageStatus = 'success' | 'error' | 'rate_limited' | 'cancelled';

export interface UsageRecord {
  id: string;
  requestId: string;
  accountId: string;
  provider: ProviderKind;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  status: UsageStatus;
  errorKind?: ProviderErrorKind;
  /** Epoch milliseconds. */
  ts: number;
}

export type TaskStatus = 'PENDING' | 'IN_PROGRESS' | 'SUCCESS' | 'FAILED';

export interface TaskNode {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  dependsOn: string[];
  priority?: number;
  acceptance?: string[];
  attempts?: number;
  branch?: string;
  notes?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TaskGraph {
  version: 1;
  tasks: TaskNode[];
}

export type RunnerState =
  | 'idle'
  | 'selecting'
  | 'preparing'
  | 'implementing'
  | 'validating'
  | 'repairing'
  | 'merging'
  | 'paused'
  | 'stopped'
  | 'error';

export interface RunnerStatus {
  state: RunnerState;
  taskId?: string;
  repairCycle?: number;
  startedAt?: string;
  lastError?: string;
}

export type GoalTaskKind = 'code' | 'artifact';

export interface GoalRole {
  id: string;
  description: string;
  route?: string;
}

export interface GoalTask {
  id: string;
  title: string;
  description?: string;
  role: string;
  kind: GoalTaskKind;
  status: TaskStatus;
  dependsOn: string[];
  acceptance?: string[];
  round: number;
  attempts: number;
  artifact?: string;
  runnerTaskId?: string;
  notes?: string;
}

export type GoalStatus =
  | 'planning'
  | 'running'
  | 'reviewing'
  | 'planned'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'budget_exhausted';

export interface GoalLimits {
  maxRounds: number;
  maxTasks: number;
  maxTokens: number;
  tokensUsed: number;
}

export interface Goal {
  id: string;
  objective: string;
  status: GoalStatus;
  round: number;
  limits: GoalLimits;
  roles: GoalRole[];
  tasks: GoalTask[];
  activeTaskId?: string;
  summary?: string;
  lastError?: string;
  dryRun?: boolean;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export type ProviderErrorKind =
  | 'rate_limit'
  | 'quota_exhausted'
  | 'unavailable'
  | 'context_length'
  | 'auth'
  | 'bad_request'
  | 'timeout'
  | 'network'
  | 'unknown';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// ---------------------------------------------------------------------------
// Mirrored from packages/core/src/events.ts
// ---------------------------------------------------------------------------

export type DaveEvent =
  | {
      type: 'request.started';
      requestId: string;
      model: string;
      accountId: string;
      provider: ProviderKind;
      ts: number;
    }
  | {
      type: 'request.completed';
      requestId: string;
      model: string;
      accountId: string;
      provider: ProviderKind;
      promptTokens: number;
      completionTokens: number;
      latencyMs: number;
      ts: number;
    }
  | {
      type: 'request.failed';
      requestId: string;
      accountId: string;
      provider: ProviderKind;
      error: { kind: ProviderErrorKind; message: string; status?: number };
      ts: number;
    }
  | {
      type: 'router.failover';
      requestId: string;
      fromAccountId: string;
      toAccountId: string | null;
      reason: ProviderErrorKind;
      ts: number;
    }
  | { type: 'account.updated'; account: Account; ts: number }
  | { type: 'account.removed'; accountId: string; ts: number }
  | { type: 'quota.updated'; usage: AccountUsage; ts: number }
  | { type: 'task.updated'; task: TaskNode; ts: number }
  | { type: 'task.removed'; taskId: string; ts: number }
  | { type: 'runner.status'; status: RunnerStatus; ts: number }
  | { type: 'runner.log'; level: LogLevel; message: string; taskId?: string; ts: number }
  | { type: 'goal.updated'; goal: Goal; ts: number }
  | {
      type: 'goal.log';
      goalId: string;
      level: LogLevel;
      message: string;
      role?: string;
      taskId?: string;
      ts: number;
    }
  | { type: 'log'; level: LogLevel; scope: string; message: string; ts: number };

export type DaveEventType = DaveEvent['type'];

// ---------------------------------------------------------------------------
// HTTP envelopes from docs/API.md (not exported by core)
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: 'ok' | (string & {});
  version: string;
  uptimeSec: number;
  experimental: { geminiWeb: boolean; multiAccountRotation: boolean };
}

export interface AccountCreate {
  provider: ProviderKind;
  label: string;
  priority?: number;
  weight?: number;
  limits?: QuotaLimits;
  config?: Record<string, unknown>;
  subscription?: SubscriptionInfo;
  /** Write-only: encrypted at rest, never returned by any endpoint. */
  secret?: string;
}

export type AccountPatch = Partial<Omit<AccountCreate, 'provider' | 'subscription'>> & {
  enabled?: boolean;
  /** Replaces the subscription details; `null` clears them. */
  subscription?: SubscriptionInfo | null;
};

export interface TimeseriesBucket {
  ts: number;
  tokens: number;
  requests: number;
  byAccount: Record<string, { tokens: number; requests: number }>;
}

export interface RoutesResponse {
  defaultRoute: string;
  routes: Route[];
}

export interface TasksResponse {
  project: { root: string; name: string } | null;
  graph: TaskGraph;
}

/** `POST /api/tasks` body. The task always starts PENDING. */
export interface TaskCreate {
  id: string;
  title: string;
  description?: string;
  dependsOn?: string[];
  priority?: number;
  acceptance?: string[];
}

/** `PATCH /api/tasks/:id` body. `null` clears an optional field. */
export interface TaskPatch {
  title?: string;
  description?: string | null;
  dependsOn?: string[];
  priority?: number | null;
  acceptance?: string[] | null;
  notes?: string | null;
  status?: TaskStatus;
}

/** `POST /api/goals` body. Limits are clamped to the gateway's `goal.*` config. */
export interface GoalStart {
  objective: string;
  maxRounds?: number;
  maxTasks?: number;
  maxTokens?: number;
  dryRun?: boolean;
}

/** `GET /api/goals/:id/artifacts/:taskId` response payload. */
export interface GoalArtifact {
  taskId: string;
  path: string;
  content: string;
}

/** `PUT /api/routes` body. `defaultRoute` must be one of `routes`. */
export interface RoutesUpdate {
  routes: Route[];
  defaultRoute?: string;
}

export interface RoutesUpdateResponse extends RoutesResponse {
  /** The project's own config also sets routes, so it wins after a restart. */
  shadowedByProject: boolean;
}

export interface BrainResponse {
  state: string;
  architecture: string;
}

export interface ApiErrorBody {
  error: {
    message: string;
    code: string;
    /** `cycle` errors: the dependency path, first id repeated at the end. */
    cycle?: string[];
    /** `has_dependents` errors: the tasks that still depend on the one being deleted. */
    dependents?: string[];
  };
}
