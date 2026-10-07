import type { Account, ProviderKind, Route, RoutesUpdate } from './types';

/**
 * Pure logic behind the routes editor: stable-keyed drafts, reordering, validation (the same
 * rules as the config schema and `PUT /api/routes`) and the conversion back to a request body.
 */

/** Same pattern as the config schema: lowercase kebab-case. */
export const ROUTE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface TargetDraft {
  /** Stable React key; never sent to the gateway. */
  key: string;
  provider: ProviderKind;
  model: string;
  /** Empty string = let the balancer pick. */
  accountId: string;
}

export interface RouteDraft {
  key: string;
  name: string;
  description: string;
  targets: TargetDraft[];
}

export interface RoutesDraft {
  routes: RouteDraft[];
  /** Key of the default route, or null when there is none. */
  defaultKey: string | null;
}

let counter = 0;
export const newKey = (prefix: string): string => `${prefix}-${++counter}`;

export function newTarget(provider: ProviderKind = 'anthropic'): TargetDraft {
  return { key: newKey('t'), provider, model: '', accountId: '' };
}

export function newRoute(name = ''): RouteDraft {
  return { key: newKey('r'), name, description: '', targets: [newTarget()] };
}

export function toDraft(routes: readonly Route[], defaultRoute: string): RoutesDraft {
  const drafts: RouteDraft[] = routes.map((route) => ({
    key: newKey('r'),
    name: route.name,
    description: route.description ?? '',
    targets: route.targets.map((t) => ({
      key: newKey('t'),
      provider: t.provider,
      model: t.model,
      accountId: t.accountId ?? '',
    })),
  }));
  return { routes: drafts, defaultKey: drafts.find((r) => r.name === defaultRoute)?.key ?? null };
}

/** Request body for `PUT /api/routes`. */
export function toRequest(draft: RoutesDraft): RoutesUpdate {
  const routes: Route[] = draft.routes.map((route) => {
    const description = route.description.trim();
    return {
      name: route.name.trim(),
      ...(description && { description }),
      targets: route.targets.map((t) => ({
        provider: t.provider,
        model: t.model.trim(),
        ...(t.accountId && { accountId: t.accountId }),
      })),
    };
  });
  const def = draft.routes.find((r) => r.key === draft.defaultKey);
  return { routes, ...(def && { defaultRoute: def.name.trim() }) };
}

/** Returns a copy of `list` with the item at `from` moved to `to` (clamped; no-op when equal). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length) return next;
  const target = Math.max(0, Math.min(next.length - 1, to));
  if (target === from) return next;
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item as T);
  return next;
}

/** Suggests a free route name such as `route-2`. */
export function suggestRouteName(routes: readonly RouteDraft[]): string {
  const taken = new Set(routes.map((r) => r.name));
  for (let n = routes.length + 1; ; n++) {
    if (!taken.has(`route-${n}`)) return `route-${n}`;
  }
}

export interface RouteErrors {
  name?: string;
  targets?: string;
  /** Per target key. */
  target: Record<string, { model?: string; accountId?: string }>;
}

export interface DraftValidation {
  byRoute: Record<string, RouteErrors>;
  defaultRoute?: string;
  valid: boolean;
}

export function validateDraft(
  draft: RoutesDraft,
  accounts: readonly Pick<Account, 'id' | 'provider'>[] = [],
): DraftValidation {
  const byRoute: Record<string, RouteErrors> = {};
  const names = new Map<string, number>();
  for (const route of draft.routes) {
    const name = route.name.trim();
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  let valid = true;
  for (const route of draft.routes) {
    const errors: RouteErrors = { target: {} };
    const name = route.name.trim();
    if (!name) errors.name = 'Give the route a name.';
    else if (!ROUTE_NAME_PATTERN.test(name)) {
      errors.name = 'Lowercase letters, digits and hyphens only, starting with a letter or digit.';
    } else if ((names.get(name) ?? 0) > 1) errors.name = 'Another route already uses this name.';

    if (route.targets.length === 0) errors.targets = 'Add at least one target.';
    for (const target of route.targets) {
      const t: { model?: string; accountId?: string } = {};
      if (!target.model.trim()) t.model = 'Enter a model id.';
      if (target.accountId) {
        const account = accounts.find((a) => a.id === target.accountId);
        if (!account) t.accountId = 'This account no longer exists.';
        else if (account.provider !== target.provider) {
          t.accountId = 'The pinned account belongs to a different provider.';
        }
      }
      if (t.model || t.accountId) errors.target[target.key] = t;
    }
    if (errors.name || errors.targets || Object.keys(errors.target).length > 0) valid = false;
    byRoute[route.key] = errors;
  }
  let defaultRoute: string | undefined;
  if (draft.routes.length > 0 && !draft.routes.some((r) => r.key === draft.defaultKey)) {
    defaultRoute = 'Pick the default route.';
    valid = false;
  }
  return { byRoute, ...(defaultRoute && { defaultRoute }), valid };
}

/** True when the draft differs from `routes`/`defaultRoute` (what the gateway has now). */
export function isDirty(
  draft: RoutesDraft,
  routes: readonly Route[],
  defaultRoute: string,
): boolean {
  return (
    JSON.stringify(toRequest(draft)) !== JSON.stringify(canonicalRequest(routes, defaultRoute))
  );
}

function canonicalRequest(routes: readonly Route[], defaultRoute: string): RoutesUpdate {
  return toRequest(toDraft(routes, defaultRoute));
}
