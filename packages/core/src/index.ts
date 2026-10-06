// --- phase 3: dual brain ---
export {
  buildTaskContext,
  CONTEXT_TRUNCATION_MARKER,
  DAVECODE_SYSTEM_PROMPT,
  DEFAULT_CONTEXT_BUDGET_CHARS,
  type TaskContextInput,
} from './brain/context';
export {
  GlobalBrain,
  InvalidNoteNameError,
  type NoteInfo,
  sanitizeNoteName,
} from './brain/global';
export {
  type BlockedTask,
  blockedTasks,
  canTransition,
  findCycles,
  type GraphSummary,
  nextTask,
  parseTaskGraph,
  readyTasks,
  setTaskStatus,
  summarize,
  TASK_STATUSES,
  TaskGraphError,
  type TaskGraphIssue,
  type TaskGraphIssueCode,
  type TaskPatch,
  taskGraphSchema,
  topologicalOrder,
  type UpdateOptions,
  updateTask,
  validateTaskGraph,
} from './brain/graph';
export { type LockOptions, LockTimeoutError, withFileLock } from './brain/lock';
export {
  findProjectRoot,
  ProjectBrain,
  type ProjectBrainInitOptions,
  type ProjectBrainOptions,
  type ProjectBrainSnapshot,
} from './brain/project';
export { configSchema, type DaveConfig, type DaveConfigInput } from './config/schema';
export {
  errorKindFromStatus,
  isFailoverEligible,
  ProviderError,
  type ProviderErrorOptions,
  parseRetryAfter,
} from './errors';
export {
  type DaveEvent,
  type DaveEventHandler,
  type DaveEventInput,
  type DaveEventType,
  EventBus,
  type SequencedEvent,
} from './events';
export {
  davecodeHome,
  type GlobalPaths,
  globalPaths,
  type ProjectPaths,
  projectPaths,
} from './paths';
// --- providers ---
export {
  AnthropicProvider,
  ClaudeCliProvider,
  CodexCliProvider,
  type CreateProvidersOptions,
  createProviders,
  GeminiProvider,
  type GeminiWebDriver,
  GeminiWebProvider,
  OpenAICompatibleProvider,
  OpenAIProvider,
  type OpenAIProviderOptions,
} from './providers';
export * from './types';
export { VERSION } from './version';

// --- phase 1 & 2: storage, identity, quotas, router, engine ---

export {
  ConfigError,
  deepMerge,
  envLayer,
  type LoadConfigOptions,
  loadConfig,
} from './config/loader';
export { type CreateEngineOptions, createEngine, type Engine } from './engine';
export {
  type ChromiumContext,
  type ChromiumLaunchOptions,
  ChromiumProfileManager,
  type ChromiumProfileManagerOptions,
  ChromiumUnavailableError,
  ExperimentalDisabledError,
} from './identity/chromium';
export { Keyring, KeyringError, type KeyringOptions, loadMasterKey } from './identity/keyring';
export { accountDir, SandboxManager } from './identity/sandbox';
export {
  approximateTokens,
  countTextTokens,
  estimateTokens,
  type TokenInput,
} from './rate-limiter/tokens';
export { UsageTracker, type UsageTrackerOptions } from './rate-limiter/tracker';
export {
  type Clock,
  limitsFor,
  QUOTA_WINDOWS,
  QuotaEngine,
  type QuotaEngineOptions,
  type RecordOptions,
  WINDOW_MS,
} from './rate-limiter/window';
export {
  accountServes,
  type Candidate,
  configuredModels,
  defaultModelFor,
  inferProviders,
  type ModelSpec,
  PROVIDER_KINDS,
  parseModel,
  ROUTE_PREFIX,
  resolveCandidates,
} from './router/candidates';
export {
  CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitState,
} from './router/circuit-breaker';
export { RouterError, type RouterErrorCode, type RouterErrorOptions } from './router/errors';
export {
  type CompletionResult,
  type RankedCandidate,
  type RouteRequestOptions,
  Router,
  type RouterOptions,
  type RoutingMeta,
  type RoutingPlan,
  type SkipReason,
  type StreamResult,
} from './router/router';
export {
  type AccountCreateInput,
  AccountRepository,
  type AccountUpdateInput,
} from './storage/accounts';
export { type AuditEntry, type AuditInput, AuditLog } from './storage/audit';
export {
  type Database,
  MIGRATIONS,
  migrate,
  type OpenDatabaseOptions,
  openDatabase,
  schemaVersion,
} from './storage/database';
export { newId } from './storage/ids';
export { type TimeseriesOptions, UsageRepository, type UsageTotals } from './storage/usage';
// --- end phase 1 & 2 ---

// --- phase 4: autonomous runner ---

export {
  CLAUDE_CLI_INSTRUCTIONS,
  ClaudeCliExecutor,
  type ClaudeCliExecutorOptions,
  selectClaudeAccount,
} from './autonomous/claude-cli-executor';
export { type CreateRunnerOptions, createExecutor, createRunner } from './autonomous/create';
export {
  BuiltinExecutor,
  type BuiltinExecutorOptions,
  type Executor,
  ExecutorAbortedError,
  ExecutorError,
  type ExecutorLogger,
  type ExecutorResult,
  type ExecutorRunOptions,
  type ExecutorSession,
  type ExecutorStopReason,
  type ExecutorTask,
  initialTaskPrompt,
  repairPrompt,
  routeModel,
  TASK_INSTRUCTIONS,
} from './autonomous/executor';
export {
  assertSafeRef,
  BRAIN_DIR,
  type CommitOptions,
  Git,
  GitError,
  type GitOptions,
  type PullRequestResult,
} from './autonomous/git';
export {
  acceptanceOf,
  type CreateJudgeDeps,
  createJudge,
  DEFAULT_JEV_BASE_URL,
  DEFAULT_JEV_MODEL,
  extractJsonObject,
  JevJudge,
  type JevJudgeOptions,
  type Judge,
  type JudgeConfig,
  JudgeError,
  type JudgeInput,
  type JudgeKind,
  type JudgeVerdict,
  LLM_JUDGE_PROMPT,
  LlmJudge,
  type LlmJudgeOptions,
  llmVerdictSchema,
  NoneJudge,
} from './autonomous/judge';
export {
  CommandError,
  type ProcessResult,
  type RunProcessOptions,
  runProcess,
  splitCommand,
  truncateHead,
  truncateTail,
} from './autonomous/process';
export {
  AutonomousRunner,
  type AutonomousRunnerOptions,
  commitMessage,
  type RunnerConfig,
  RunnerError,
  type RunnerErrorCode,
  type RunOnceResult,
  type RunOutcome,
} from './autonomous/runner';
export {
  DEFAULT_ALLOWED_COMMANDS,
  PathEscapeError,
  READ_ONLY_GIT_SUBCOMMANDS,
  type ResolvedPath,
  resolveRepoPath,
  TOOL_DEFINITIONS,
  type ToolOutcome,
  WorkspaceTools,
  type WorkspaceToolsOptions,
} from './autonomous/tools';
export {
  summarizeValidation,
  VALIDATION_STEPS,
  type ValidationCommands,
  type ValidationReport,
  type ValidationStep,
  type ValidationStepName,
  Validator,
  type ValidatorOptions,
} from './autonomous/validator';
export { ProjectBrainSource } from './brain/source';
// --- end phase 4 ---
