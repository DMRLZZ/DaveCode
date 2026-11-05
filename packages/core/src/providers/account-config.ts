/**
 * Which `Account.config` keys the HTTP API may write, and the rule that keeps a stored secret
 * bound to the endpoint it was saved for.
 *
 * Executable settings (`binaryPath`, `binaryArgs`) and anything else not listed here can only
 * come from the machine's owner: the local `davecode` CLI working on `state.db` directly.
 */
import type { Account, ProviderKind } from '../types';

/** Config keys that choose where requests (and the stored secret) are sent. */
export const ENDPOINT_CONFIG_KEYS: readonly string[] = ['baseUrl'];

const MODEL_KEYS = ['models', 'defaultModel'] as const;

/** Keys the API may set per provider. Everything else is rejected. */
export const API_CONFIG_KEYS: Record<ProviderKind, readonly string[]> = {
  anthropic: ['baseUrl', ...MODEL_KEYS],
  openai: ['baseUrl', 'includeUsage', ...MODEL_KEYS],
  gemini: ['baseUrl', ...MODEL_KEYS],
  'openai-compatible': ['baseUrl', 'includeUsage', ...MODEL_KEYS],
  'claude-cli': [...MODEL_KEYS],
  'codex-cli': [...MODEL_KEYS],
  'gemini-cli': [...MODEL_KEYS],
  'antigravity-cli': [...MODEL_KEYS],
  'gemini-web': ['models'],
};

function isStringList(value: unknown): boolean {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0);
}

/**
 * Problems with a config object received over the API (empty when it is acceptable): unknown or
 * not-allowed keys for the provider (unless unchanged from `existing`), and malformed values for
 * the allowed ones.
 */
export function apiConfigIssues(
  provider: ProviderKind,
  config: Record<string, unknown>,
  existing: Record<string, unknown> = {},
): string[] {
  const allowed = API_CONFIG_KEYS[provider];
  const issues: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (!allowed.includes(key)) {
      // Echoing a value the account already has (a client sending back the whole config) is not a change.
      if (key in existing && JSON.stringify(existing[key]) === JSON.stringify(value)) continue;
      issues.push(
        `config.${key} cannot be set through the API for ${provider} accounts` +
          (allowed.length > 0 ? ` (allowed: ${allowed.join(', ')})` : ''),
      );
      continue;
    }
    if (key === 'baseUrl') {
      if (typeof value !== 'string' || !isHttpUrl(value)) {
        issues.push('config.baseUrl must be an http(s) URL without embedded credentials');
      }
    } else if (key === 'models') {
      if (!isStringList(value)) issues.push('config.models must be a list of model ids');
    } else if (key === 'defaultModel') {
      if (typeof value !== 'string' || !value) issues.push('config.defaultModel must be a string');
    } else if (key === 'includeUsage' && typeof value !== 'boolean') {
      issues.push('config.includeUsage must be true or false');
    }
  }
  return issues;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

/**
 * Config to store after an API `PATCH`: the incoming API-writable keys replace the old ones,
 * while keys the API may not write (e.g. a `binaryPath` the owner set locally) are kept.
 */
export function mergeApiConfig(
  provider: ProviderKind,
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = API_CONFIG_KEYS[provider];
  const kept = Object.fromEntries(
    Object.entries(existing).filter(([key]) => !allowed.includes(key)),
  );
  return { ...kept, ...incoming };
}

function endpointOf(config: Record<string, unknown>): string {
  return ENDPOINT_CONFIG_KEYS.map((key) => {
    const value = config[key];
    return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  }).join('\n');
}

/** True when `next` points the account at a different endpoint than `existing` does. */
export function endpointChanged(
  existing: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  return endpointOf(existing) !== endpointOf(next);
}

/**
 * A stored secret is only ever sent to the endpoint it was saved with. Moving an account that
 * already holds a secret to another endpoint therefore needs the secret in the same request;
 * returns the error message when that is missing.
 */
export function endpointRebindIssue(
  existing: Pick<Account, 'config' | 'hasSecret'>,
  nextConfig: Record<string, unknown> | undefined,
  secretSupplied: boolean,
): string | undefined {
  if (!nextConfig || secretSupplied || !existing.hasSecret) return undefined;
  if (!endpointChanged(existing.config, nextConfig)) return undefined;
  return 'Changing the endpoint of an account that has a stored secret requires sending the secret again in the same request';
}
