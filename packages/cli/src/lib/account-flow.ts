import {
  type Account,
  type DaveConfig,
  EXPERIMENTAL_PROVIDER_KINDS,
  type ProviderKind,
  type QuotaLimits,
  SUBSCRIPTION_PROVIDER_KINDS,
} from '@davecode/core';
import { CliError } from '../errors';
import type { AccountCreate } from './accounts-backend';
import type { Prompter } from './prompter';

// ---------------------------------------------------------------------------
// Provider catalogue
// ---------------------------------------------------------------------------

export type AuthKind = 'api-key' | 'optional-key' | 'cli-login' | 'browser';

export interface ProviderInfo {
  kind: ProviderKind;
  name: string;
  auth: AuthKind;
  defaultLabel: string;
  /** Default CLI binary for `cli-login` providers. */
  binary?: string;
}

export const PROVIDERS: readonly ProviderInfo[] = [
  { kind: 'anthropic', name: 'Anthropic API', auth: 'api-key', defaultLabel: 'Anthropic' },
  { kind: 'openai', name: 'OpenAI API', auth: 'api-key', defaultLabel: 'OpenAI' },
  { kind: 'gemini', name: 'Google Gemini API', auth: 'api-key', defaultLabel: 'Gemini' },
  {
    kind: 'openai-compatible',
    name: 'OpenAI-compatible (OpenRouter, Ollama, LM Studio, vLLM…)',
    auth: 'optional-key',
    defaultLabel: 'Local models',
  },
  {
    kind: 'claude-cli',
    name: 'Claude Code CLI (your Claude login)',
    auth: 'cli-login',
    defaultLabel: 'Claude Code',
    binary: 'claude',
  },
  {
    kind: 'codex-cli',
    name: 'Codex CLI (your ChatGPT/OpenAI login)',
    auth: 'cli-login',
    defaultLabel: 'Codex',
    binary: 'codex',
  },
  {
    kind: 'gemini-web',
    name: 'Gemini web session (experimental)',
    auth: 'browser',
    defaultLabel: 'Gemini web',
  },
];

export function providerInfo(kind: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.kind === kind);
}

export const DEFAULT_COMPATIBLE_URL = 'http://localhost:11434/v1';

// ---------------------------------------------------------------------------
// Terms-of-Service policy
// ---------------------------------------------------------------------------

export const GEMINI_WEB_TOS =
  'gemini-web automates the consumer Gemini web app through a browser profile. This likely ' +
  'violates Google’s Terms of Service and your account can be rate-limited or suspended.';

export const ROTATION_TOS =
  'Rotating several subscription logins of the same provider to get around per-account limits ' +
  'may violate the provider’s consumer terms; accounts can be rate-limited or suspended.';

export interface Policy {
  /** The account cannot be added with the current flags. */
  blocked?: { message: string; hint: string };
  /** Shown (and, interactively, confirmed) before adding. */
  warnings: string[];
}

/** Experimental-flag rules for adding an account of `provider`. */
export function accountPolicy(
  provider: ProviderKind,
  config: Pick<DaveConfig, 'experimental'>,
  existing: Pick<Account, 'provider'>[],
): Policy {
  const warnings: string[] = [];
  if (EXPERIMENTAL_PROVIDER_KINDS.includes(provider)) {
    if (!config.experimental.geminiWeb) {
      return {
        warnings,
        blocked: {
          message: `${provider} is experimental and disabled. ${GEMINI_WEB_TOS}`,
          hint: 'If you accept the risk, set "experimental": { "geminiWeb": true } in ~/.davecode/config.json (or DAVECODE_EXPERIMENTAL_GEMINI_WEB=1).',
        },
      };
    }
    warnings.push(GEMINI_WEB_TOS);
  }
  const sameProvider = existing.filter((a) => a.provider === provider).length;
  if (SUBSCRIPTION_PROVIDER_KINDS.includes(provider) && sameProvider > 0) {
    if (!config.experimental.multiAccountRotation) {
      return {
        warnings,
        blocked: {
          message: `You already have a ${provider} account. ${ROTATION_TOS}`,
          hint: 'If you accept the risk, set "experimental": { "multiAccountRotation": true } in ~/.davecode/config.json (or DAVECODE_EXPERIMENTAL_MULTI_ACCOUNT_ROTATION=1).',
        },
      };
    }
    warnings.push(ROTATION_TOS);
  }
  return { warnings };
}

// ---------------------------------------------------------------------------
// Flags → AccountCreate
// ---------------------------------------------------------------------------

export interface AddFlags {
  provider?: string;
  label?: string;
  priority?: number;
  weight?: number;
  /** Discouraged: visible in shell history and process listings. */
  secret?: string;
  /** Read the secret from this environment variable. */
  secretEnv?: string;
  /** Read the secret from stdin. */
  secretStdin?: boolean;
  baseUrl?: string;
  model?: string[];
  defaultModel?: string;
  binaryPath?: string;
  /** `key=value` quota limits, e.g. `tokens5h=500000`. */
  limit?: string[];
  /** commander's `--disabled`. */
  disabled?: boolean;
}

const LIMIT_KEYS = [
  'tpm',
  'rpm',
  'tokens5h',
  'requests5h',
  'tokensDaily',
  'requestsDaily',
] as const;

export function parseLimits(pairs: string[] = []): QuotaLimits {
  const limits: QuotaLimits = {};
  for (const pair of pairs) {
    const [rawKey, rawValue] = pair.split('=', 2);
    const key = LIMIT_KEYS.find((k) => k.toLowerCase() === rawKey?.trim().toLowerCase());
    const value = Number(rawValue);
    if (!key) {
      throw new CliError(`Unknown limit ${JSON.stringify(rawKey)}`, {
        hint: `Use one of: ${LIMIT_KEYS.join(', ')} (e.g. --limit tokens5h=500000)`,
      });
    }
    if (!Number.isInteger(value) || value <= 0) {
      throw new CliError(
        `Limit ${key} must be a positive integer, got ${JSON.stringify(rawValue)}`,
      );
    }
    limits[key] = value;
  }
  return limits;
}

export function validateUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? undefined
      : 'must be an http(s) URL';
  } catch {
    return 'must be a valid URL, e.g. http://localhost:11434/v1';
  }
}

function requireProvider(value: string | undefined): ProviderInfo {
  if (!value) {
    throw new CliError('Missing --provider', {
      hint: `One of: ${PROVIDERS.map((p) => p.kind).join(', ')}`,
    });
  }
  const info = providerInfo(value);
  if (!info) {
    throw new CliError(`Unknown provider ${JSON.stringify(value)}`, {
      hint: `One of: ${PROVIDERS.map((p) => p.kind).join(', ')}`,
    });
  }
  return info;
}

export interface SecretSources {
  env: NodeJS.ProcessEnv;
  readStdin: () => Promise<string>;
}

async function secretFromFlags(
  flags: AddFlags,
  sources: SecretSources,
): Promise<string | undefined> {
  const chosen = [flags.secret !== undefined, !!flags.secretEnv, !!flags.secretStdin].filter(
    Boolean,
  );
  if (chosen.length > 1) {
    throw new CliError('Use only one of --secret, --secret-env and --secret-stdin');
  }
  if (flags.secretStdin) {
    const value = (await sources.readStdin()).trim();
    if (!value) throw new CliError('No secret received on stdin');
    return value;
  }
  if (flags.secretEnv) {
    const value = sources.env[flags.secretEnv]?.trim();
    if (!value) throw new CliError(`Environment variable ${flags.secretEnv} is empty or unset`);
    return value;
  }
  const value = flags.secret?.trim();
  return value ? value : undefined;
}

function providerConfig(
  info: ProviderInfo,
  values: { baseUrl?: string; models?: string[]; defaultModel?: string; binaryPath?: string },
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (values.baseUrl) config.baseUrl = values.baseUrl.replace(/\/+$/, '');
  if (values.models && values.models.length > 0) config.models = [...new Set(values.models)];
  if (values.defaultModel) config.defaultModel = values.defaultModel;
  if (values.binaryPath && info.auth === 'cli-login') config.binaryPath = values.binaryPath;
  return config;
}

/** Build an account from flags only (scripts, CI). Never prompts. */
export async function accountFromFlags(
  flags: AddFlags,
  sources: SecretSources,
): Promise<AccountCreate> {
  const info = requireProvider(flags.provider);
  const secret = await secretFromFlags(flags, sources);
  if (info.auth === 'api-key' && !secret) {
    throw new CliError(`${info.name} needs an API key`, {
      hint: 'Pass it with --secret-env <VAR> or pipe it with --secret-stdin.',
    });
  }
  if (secret && (info.auth === 'cli-login' || info.auth === 'browser')) {
    throw new CliError(`${info.kind} accounts do not take a secret`, {
      hint:
        info.auth === 'cli-login'
          ? 'Log in with `davecode accounts login <id>` after adding the account.'
          : 'The browser profile holds the session.',
    });
  }
  if (info.kind === 'openai-compatible') {
    if (!flags.baseUrl) {
      throw new CliError('openai-compatible accounts need --base-url', {
        hint: `e.g. --base-url ${DEFAULT_COMPATIBLE_URL} for Ollama`,
      });
    }
  }
  if (flags.baseUrl) {
    const problem = validateUrl(flags.baseUrl);
    if (problem) throw new CliError(`--base-url ${problem}`);
  }
  const create: AccountCreate = {
    provider: info.kind,
    label: flags.label?.trim() || info.defaultLabel,
    config: providerConfig(info, {
      ...(flags.baseUrl ? { baseUrl: flags.baseUrl } : {}),
      ...(flags.model ? { models: flags.model } : {}),
      ...(flags.defaultModel ? { defaultModel: flags.defaultModel } : {}),
      ...(flags.binaryPath ? { binaryPath: flags.binaryPath } : {}),
    }),
  };
  if (flags.priority !== undefined) create.priority = flags.priority;
  if (flags.weight !== undefined) create.weight = flags.weight;
  const limits = parseLimits(flags.limit);
  if (Object.keys(limits).length > 0) create.limits = limits;
  if (flags.disabled) create.enabled = false;
  if (secret) create.secret = secret;
  return create;
}

// ---------------------------------------------------------------------------
// Interactive flow
// ---------------------------------------------------------------------------

export interface InteractiveDeps {
  prompter: Prompter;
  config: Pick<DaveConfig, 'experimental'>;
  existing: Pick<Account, 'provider' | 'label'>[];
  /** Print a line (warnings, summary). */
  say: (line: string) => void;
  /** Style ToS warnings. */
  warn?: (text: string) => string;
}

function uniqueLabel(base: string, existing: Pick<Account, 'label'>[]): string {
  const taken = new Set(existing.map((a) => a.label.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Ask for whatever the flags did not provide. Returns `undefined` when the user declines a
 * Terms-of-Service warning or the final confirmation.
 */
export async function accountInteractively(
  flags: AddFlags,
  deps: InteractiveDeps,
): Promise<AccountCreate | undefined> {
  const { prompter, say } = deps;
  const warn = deps.warn ?? ((t: string) => t);

  const kind = flags.provider
    ? requireProvider(flags.provider).kind
    : await prompter.select(
        'Provider',
        PROVIDERS.map((p) => ({ value: p.kind, label: p.name, hint: authHint(p.auth) })),
        'anthropic',
      );
  const info = requireProvider(kind);

  const policy = accountPolicy(info.kind, deps.config, deps.existing);
  if (policy.blocked) throw new CliError(policy.blocked.message, { hint: policy.blocked.hint });
  for (const warning of policy.warnings) {
    say(warn(`! ${warning}`));
    if (!(await prompter.confirm('I understand the risk. Continue?', false))) return undefined;
  }

  const label =
    flags.label?.trim() ||
    (await prompter.text('Label', {
      initial: uniqueLabel(info.defaultLabel, deps.existing),
      validate: (v) => (v.trim() ? undefined : 'a label is required'),
    }));

  const priority =
    flags.priority ??
    Number(
      await prompter.text('Priority (lower is tried first)', {
        initial: '100',
        validate: (v) => (/^\d+$/.test(v.trim()) ? undefined : 'enter a non-negative integer'),
      }),
    );

  let baseUrl = flags.baseUrl;
  let models = flags.model;
  if (info.kind === 'openai-compatible') {
    baseUrl ??= await prompter.text('Base URL', {
      initial: DEFAULT_COMPATIBLE_URL,
      validate: validateUrl,
    });
    if (!models) {
      const answer = await prompter.text('Models (comma-separated, empty to discover)', {
        initial: '',
      });
      models = answer
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean);
    }
  }

  let secret: string | undefined;
  if (info.auth === 'api-key' || info.auth === 'optional-key') {
    const optional = info.auth === 'optional-key';
    const answer = await prompter.secret(
      optional ? 'API key (optional, input hidden)' : `${info.name} key (input hidden)`,
      { optional },
    );
    secret = answer.trim() || undefined;
    if (!secret && !optional) throw new CliError(`${info.name} needs an API key`);
  }

  const create: AccountCreate = {
    provider: info.kind,
    label: label.trim(),
    priority,
    config: providerConfig(info, {
      ...(baseUrl ? { baseUrl } : {}),
      ...(models ? { models } : {}),
      ...(flags.defaultModel ? { defaultModel: flags.defaultModel } : {}),
      ...(flags.binaryPath ? { binaryPath: flags.binaryPath } : {}),
    }),
  };
  if (flags.weight !== undefined) create.weight = flags.weight;
  const limits = parseLimits(flags.limit);
  if (Object.keys(limits).length > 0) create.limits = limits;
  if (flags.disabled) create.enabled = false;
  if (secret) create.secret = secret;

  say('');
  for (const line of describeCreate(create)) say(`  ${line}`);
  say('');
  if (!(await prompter.confirm('Add this account?', true))) return undefined;
  return create;
}

function authHint(auth: AuthKind): string {
  switch (auth) {
    case 'api-key':
      return 'API key';
    case 'optional-key':
      return 'base URL, optional key';
    case 'cli-login':
      return 'local CLI login, isolated per account';
    default:
      return 'experimental, ToS risk';
  }
}

/** Summary lines for an account about to be created. Secrets are shown only as "set". */
export function describeCreate(create: AccountCreate): string[] {
  const lines = [
    `provider  ${create.provider}`,
    `label     ${create.label}`,
    `priority  ${create.priority ?? 100}`,
  ];
  const config = create.config ?? {};
  if (typeof config.baseUrl === 'string') lines.push(`base URL  ${config.baseUrl}`);
  if (Array.isArray(config.models) && config.models.length > 0) {
    lines.push(`models    ${config.models.join(', ')}`);
  }
  if (create.limits && Object.keys(create.limits).length > 0) {
    lines.push(
      `limits    ${Object.entries(create.limits)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')}`,
    );
  }
  if (create.secret !== undefined) lines.push('secret    set (stored encrypted)');
  return lines;
}
