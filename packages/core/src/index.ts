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
