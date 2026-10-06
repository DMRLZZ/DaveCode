import type { Account, ProviderKind, Route } from '../types';

export const PROVIDER_KINDS: readonly ProviderKind[] = [
  'anthropic',
  'openai',
  'gemini',
  'openai-compatible',
  'claude-cli',
  'codex-cli',
  'gemini-web',
];

/** Prefix that addresses a configured route, e.g. `davecode/auto`. */
export const ROUTE_PREFIX = 'davecode/';

/** How the `model` field of a request was interpreted. */
export type ModelSpec =
  /** A configured route; `route === undefined` means the implicit default route. */
  | { kind: 'route'; name: string; route?: Route }
  | { kind: 'provider'; provider: ProviderKind; model: string }
  | { kind: 'model'; model: string };

/** One (account, concrete model) pair the router may try. */
export interface Candidate {
  account: Account;
  provider: ProviderKind;
  /** Model id sent upstream. */
  model: string;
  /** Position of the route target that produced this candidate (0 outside routes). */
  targetIndex: number;
}

function isProviderKind(value: string): value is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(value);
}

/**
 * Interpret a request's `model`:
 * `davecode/<route>` (unknown names fall back to the default route), `<provider>/<model>`,
 * or a bare model id (which may itself contain slashes, e.g. OpenRouter ids).
 */
export function parseModel(
  model: string,
  routes: readonly Route[],
  defaultRoute: string,
): ModelSpec {
  if (model.startsWith(ROUTE_PREFIX)) {
    const name = model.slice(ROUTE_PREFIX.length);
    const route =
      routes.find((r) => r.name === name) ?? routes.find((r) => r.name === defaultRoute);
    return route
      ? { kind: 'route', name: route.name, route }
      : { kind: 'route', name: defaultRoute };
  }
  const slash = model.indexOf('/');
  if (slash > 0) {
    const prefix = model.slice(0, slash);
    const rest = model.slice(slash + 1);
    if (isProviderKind(prefix) && rest.length > 0) {
      return { kind: 'provider', provider: prefix, model: rest };
    }
  }
  return { kind: 'model', model };
}

/** The account's explicit model allow-list (`config.models`), if any. */
export function configuredModels(account: Account): string[] | undefined {
  const models = account.config.models;
  if (!Array.isArray(models)) return undefined;
  const ids = models.filter((m): m is string => typeof m === 'string' && m.length > 0);
  return ids.length > 0 ? ids : undefined;
}

/** Model used for the implicit default route: `config.defaultModel`, else the first listed. */
export function defaultModelFor(account: Account): string | undefined {
  const explicit = account.config.defaultModel;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  return configuredModels(account)?.[0];
}

/** Provider families a bare model id most likely belongs to (empty when unknown). */
export function inferProviders(model: string): ProviderKind[] {
  const id = model.toLowerCase();
  if (id.startsWith('claude')) return ['anthropic', 'claude-cli'];
  if (/^(gpt-|chatgpt|codex|o\d)/.test(id)) return ['openai', 'codex-cli'];
  if (id.startsWith('gemini')) return ['gemini', 'gemini-web'];
  return [];
}

/**
 * Whether an account can serve `model`. With an allow-list the model must be listed;
 * without one the account is assumed to serve any model of its provider. For bare model
 * ids (`provider` undefined) the provider family is inferred from the id, and unknown
 * families go to OpenAI-compatible accounts.
 */
export function accountServes(account: Account, model: string, provider?: ProviderKind): boolean {
  if (provider !== undefined && account.provider !== provider) return false;
  const listed = configuredModels(account);
  if (listed) return listed.includes(model);
  if (provider !== undefined) return true;
  const families = inferProviders(model);
  return families.length > 0
    ? families.includes(account.provider)
    : account.provider === 'openai-compatible';
}

/** Every (account, model) pair matching the spec, before any availability filtering. */
export function resolveCandidates(spec: ModelSpec, accounts: readonly Account[]): Candidate[] {
  if (spec.kind === 'provider' || spec.kind === 'model') {
    const provider = spec.kind === 'provider' ? spec.provider : undefined;
    return accounts
      .filter((a) => accountServes(a, spec.model, provider))
      .map((account) => ({
        account,
        provider: account.provider,
        model: spec.model,
        targetIndex: 0,
      }));
  }
  if (!spec.route) {
    // Implicit default route: every account that declares a default model.
    const out: Candidate[] = [];
    for (const account of accounts) {
      const model = defaultModelFor(account);
      if (model) out.push({ account, provider: account.provider, model, targetIndex: 0 });
    }
    return out;
  }
  const out: Candidate[] = [];
  spec.route.targets.forEach((target, targetIndex) => {
    for (const account of accounts) {
      if (target.accountId !== undefined && account.id !== target.accountId) continue;
      if (!accountServes(account, target.model, target.provider)) continue;
      out.push({ account, provider: account.provider, model: target.model, targetIndex });
    }
  });
  return out;
}
