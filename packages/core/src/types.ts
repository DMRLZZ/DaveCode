/**
 * Shared domain contracts for DaveCode.
 *
 * Every package (gateway, router, runner, CLI, dashboard) speaks these types.
 * Changing a shape here is a breaking change — update docs/API.md alongside it.
 */

// ---------------------------------------------------------------------------
// OpenAI-compatible chat wire format (subset served on /v1/chat/completions)
// ---------------------------------------------------------------------------

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ChatRequest {
  /** Concrete model id, `provider/model`, or a DaveCode route such as `davecode/auto`. */
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  user?: string;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: FinishReason;
  }>;
  usage: Usage;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Partial<ChatMessage>;
    finish_reason: FinishReason;
  }>;
  usage?: Usage;
}

export interface ModelInfo {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

// ---------------------------------------------------------------------------
// Providers & accounts
// ---------------------------------------------------------------------------

export type ProviderKind =
  /** Anthropic Messages API with an API key. */
  | 'anthropic'
  /** OpenAI API with an API key. */
  | 'openai'
  /** Google Gemini API (AI Studio / Vertex) with an API key. */
  | 'gemini'
  /** Any OpenAI-compatible endpoint: OpenRouter, Ollama, LM Studio, vLLM, LiteLLM… */
  | 'openai-compatible'
  /** Local Claude Code CLI, isolated per account via CLAUDE_CONFIG_DIR. */
  | 'claude-cli'
  /** Local Codex CLI, isolated per account via CODEX_HOME. */
  | 'codex-cli'
  /** EXPERIMENTAL, opt-in: Gemini web session driven through a Chromium profile. */
  | 'gemini-web';

/**
 * Providers that automate consumer web sessions. They may violate the upstream
 * provider's Terms of Service and are disabled unless `experimental.geminiWeb` is on.
 */
export const EXPERIMENTAL_PROVIDER_KINDS: readonly ProviderKind[] = ['gemini-web'];

/**
 * Subscription-backed providers (one human login per account). Rotating several of
 * these to get around per-account limits requires `experimental.multiAccountRotation`.
 */
export const SUBSCRIPTION_PROVIDER_KINDS: readonly ProviderKind[] = [
  'claude-cli',
  'codex-cli',
  'gemini-web',
];

export interface QuotaLimits {
  /** Tokens per minute (60 s sliding window). */
  tpm?: number;
  /** Requests per minute (60 s sliding window). */
  rpm?: number;
  /** Tokens per rolling 5 hours (Claude Pro/Team style windows). */
  tokens5h?: number;
  /** Requests per rolling 5 hours. */
  requests5h?: number;
  /** Tokens per rolling 24 hours. */
  tokensDaily?: number;
  /** Requests per rolling 24 hours. */
  requestsDaily?: number;
}

export type AccountStatus = 'active' | 'cooldown' | 'disabled' | 'error';

export interface SubscriptionPrice {
  /** Amount per period in `currency`, e.g. 20. */
  amount: number;
  /** ISO 4217 code, e.g. "USD". */
  currency: string;
  period: 'month' | 'year';
}

/**
 * What the user pays for an account, entered by hand (DaveCode never reads billing pages).
 * Dates are `YYYY-MM-DD` or full ISO timestamps.
 */
export interface SubscriptionInfo {
  /** Plan name as the vendor calls it, e.g. "Claude Pro", "ChatGPT Plus", "API pay-as-you-go". */
  plan?: string;
  /** Last payment date. */
  paidAt?: string;
  /** Next renewal (or quota reset) date. */
  renewsAt?: string;
  price?: SubscriptionPrice;
  notes?: string;
}

export interface Account {
  id: string;
  provider: ProviderKind;
  /** Human-friendly name, e.g. "Claude Pro — work". */
  label: string;
  enabled: boolean;
  /** Lower number = tried first. */
  priority: number;
  /** Relative share of traffic among accounts with equal priority. */
  weight: number;
  limits: QuotaLimits;
  /** Plan, payment and renewal details; omitted when none were entered. */
  subscription?: SubscriptionInfo;
  /**
   * Non-secret provider settings (baseUrl, model allow-list, CLI binary path…).
   * Secrets (API keys, cookies, OAuth tokens) live encrypted in the keyring, never here.
   */
  config: Record<string, unknown>;
  status: AccountStatus;
  /** ISO timestamp until which the account is cooling down after a 429/503. */
  cooldownUntil?: string;
  lastError?: string;
  /** Whether the keyring holds a secret for this account. The secret itself is never exposed. */
  hasSecret?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderCallContext {
  account: Account;
  /** Decrypted secret for this account (API key, session token…), if any. */
  secret?: string;
  /** Isolated per-account directory (CLAUDE_CONFIG_DIR, CODEX_HOME, Chromium userDataDir). */
  sandboxDir: string;
  signal?: AbortSignal;
  /** Called with rate-limit state the upstream reported (response headers), if any. */
  reportLimits?: (limits: ReportedLimitsInput) => void;
}

export interface Provider {
  readonly kind: ProviderKind;
  listModels(ctx: ProviderCallContext): Promise<ModelInfo[]>;
  complete(req: ChatRequest, ctx: ProviderCallContext): Promise<ChatCompletion>;
  stream(req: ChatRequest, ctx: ProviderCallContext): AsyncIterable<ChatCompletionChunk>;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export interface RouteTarget {
  provider: ProviderKind;
  model: string;
  /** Pin the target to one account; omit to let the balancer pick. */
  accountId?: string;
}

export interface Route {
  /** Exposed to clients as `davecode/<name>`. */
  name: string;
  description?: string;
  /** Ordered by preference; the router fails over down the list. */
  targets: RouteTarget[];
}

// ---------------------------------------------------------------------------
// Quotas & usage
// ---------------------------------------------------------------------------

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

/** Rate-limit state as a provider reports it (headers, CLI limit messages). */
export interface ReportedLimitsInput {
  tokensRemaining?: number;
  tokensLimit?: number;
  requestsRemaining?: number;
  requestsLimit?: number;
  /** ISO timestamp when the reported window resets. */
  resetAt?: string;
  /** The provider refused the request because the quota is used up (until `resetAt`). */
  exhausted?: boolean;
}

export interface ReportedLimits extends ReportedLimitsInput {
  source: 'headers' | 'error';
  /** ISO timestamp of the observation. */
  observedAt: string;
}

/** One account in `GET /api/budget`: subscription details plus remaining capacity. */
export interface AccountBudget {
  accountId: string;
  label: string;
  provider: ProviderKind;
  enabled: boolean;
  subscription?: SubscriptionInfo;
  /** Whole days until `subscription.renewsAt` (negative when overdue). */
  renewsInDays?: number;
  /**
   * Remaining fraction 0..1 of the tightest limit, combining DaveCode's own windows and the
   * provider-reported limits. `null` when no limit is known (unmetered).
   */
  remaining: number | null;
  /** Window behind `remaining` when it comes from DaveCode's own limits. */
  tightestWindow?: QuotaWindow;
  usage: AccountUsage;
  reported?: ReportedLimits;
  /** Whether the router would currently send traffic to the account. */
  available: boolean;
  /** Why not, when `available` is false (disabled, cooldown, exhausted…). */
  unavailableReason?: string;
}

export interface BudgetSnapshot {
  /** ISO timestamp. */
  generatedAt: string;
  accounts: AccountBudget[];
  /** Compact plain-text summary injected into the orchestrator and agent prompts. */
  context: string;
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

/** One bucket of `GET /api/usage/timeseries`. Tokens are prompt + completion. */
export interface UsageBucket {
  /** Bucket start, epoch milliseconds. */
  ts: number;
  tokens: number;
  requests: number;
  byAccount: Record<string, { tokens: number; requests: number }>;
}

// ---------------------------------------------------------------------------
// Dual-brain context & task graph
// ---------------------------------------------------------------------------

export type TaskStatus = 'PENDING' | 'IN_PROGRESS' | 'SUCCESS' | 'FAILED';

export interface TaskNode {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  /** Ids of tasks that must be SUCCESS before this one is unblocked. */
  dependsOn: string[];
  /** Higher runs first among unblocked tasks. */
  priority?: number;
  /** Human-readable acceptance criteria checked by the validator/judge. */
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

// ---------------------------------------------------------------------------
// Autonomous runner
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Goal mode (a team of role-based agents working toward one objective)
// ---------------------------------------------------------------------------

/**
 * `code` tasks are handed to the autonomous runner (branch, quality gates, merge).
 * `artifact` tasks produce a markdown document under `.davecode/goals/<goal-id>/`.
 */
export type GoalTaskKind = 'code' | 'artifact';

export interface GoalRole {
  /** Lowercase id the planner assigns tasks to, e.g. `researcher`. */
  id: string;
  description: string;
  /** Route or model id this role talks to (default: `goal.route`). */
  route?: string;
}

export interface GoalTask {
  /** Unique within the goal (task-graph id syntax). */
  id: string;
  title: string;
  description?: string;
  role: string;
  kind: GoalTaskKind;
  status: TaskStatus;
  dependsOn: string[];
  acceptance?: string[];
  /** Planning round that created the task (1-based). */
  round: number;
  attempts: number;
  /** Workspace-relative path of the markdown artifact, once written. */
  artifact?: string;
  /** Project task-graph id the runner worked on (`code` tasks). */
  runnerTaskId?: string;
  /** Result summary or failure reason. */
  notes?: string;
}

export type GoalStatus =
  | 'planning'
  | 'running'
  | 'reviewing'
  /** Dry run: the plan was made and nothing was executed. */
  | 'planned'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  /** A token cap was reached or no account had capacity left. */
  | 'budget_exhausted';

export interface GoalLimits {
  /** Plan → execute → review rounds. */
  maxRounds: number;
  /** Tasks across all rounds. */
  maxTasks: number;
  /** Prompt + completion tokens across every agent and runner pass. */
  maxTokens: number;
  tokensUsed: number;
}

export interface Goal {
  id: string;
  objective: string;
  status: GoalStatus;
  /** Current round (1-based). */
  round: number;
  limits: GoalLimits;
  roles: GoalRole[];
  tasks: GoalTask[];
  /** Task being executed right now. */
  activeTaskId?: string;
  /** Reviewer's (or planner's, for dry runs) latest summary. */
  summary?: string;
  lastError?: string;
  dryRun?: boolean;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

// ---------------------------------------------------------------------------
// Errors (kinds are mirrored by ProviderError in errors.ts)
// ---------------------------------------------------------------------------

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
