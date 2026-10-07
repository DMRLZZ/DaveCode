import { describe, expect, it } from 'vitest';
import {
  isDirty,
  moveItem,
  newRoute,
  type RoutesDraft,
  suggestRouteName,
  toDraft,
  toRequest,
  validateDraft,
} from './route-edit';
import type { Route } from './types';

const routes: Route[] = [
  {
    name: 'auto',
    description: 'everything',
    targets: [
      { provider: 'anthropic', model: 'claude-x' },
      { provider: 'openai', model: 'gpt-x', accountId: 'acc_1' },
    ],
  },
  { name: 'fast', targets: [{ provider: 'openai', model: 'gpt-mini' }] },
];
const accounts = [
  { id: 'acc_1', provider: 'openai' as const },
  { id: 'acc_2', provider: 'anthropic' as const },
];

describe('moveItem', () => {
  it('moves, clamps and never mutates', () => {
    const list = ['a', 'b', 'c'];
    expect(moveItem(list, 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveItem(list, 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveItem(list, 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(list, 2, 9)).toEqual(['a', 'b', 'c']);
    expect(moveItem(list, 7, 0)).toEqual(['a', 'b', 'c']);
    expect(list).toEqual(['a', 'b', 'c']);
  });
});

describe('drafts', () => {
  it('round-trips routes and the default route', () => {
    const draft = toDraft(routes, 'fast');
    expect(draft.routes.find((r) => r.key === draft.defaultKey)?.name).toBe('fast');
    expect(toRequest(draft)).toEqual({ routes, defaultRoute: 'fast' });
  });

  it('omits empty descriptions and unpinned accounts, trims text, tracks the default by key', () => {
    const draft = toDraft(routes, 'auto');
    const first = draft.routes[0];
    if (!first) throw new Error('no route');
    first.name = ' renamed ';
    first.description = '   ';
    const target = first.targets[0];
    if (!target) throw new Error('no target');
    target.model = ' claude-y ';
    const body = toRequest(draft);
    expect(body.routes[0]).toEqual({
      name: 'renamed',
      targets: [
        { provider: 'anthropic', model: 'claude-y' },
        { provider: 'openai', model: 'gpt-x', accountId: 'acc_1' },
      ],
    });
    // Renaming the default route keeps it the default.
    expect(body.defaultRoute).toBe('renamed');
  });

  it('has no default when the stored one is not a route', () => {
    const draft = toDraft(routes, 'ghost');
    expect(draft.defaultKey).toBeNull();
    expect(toRequest(draft).defaultRoute).toBeUndefined();
  });

  it('detects changes', () => {
    const draft = toDraft(routes, 'auto');
    expect(isDirty(draft, routes, 'auto')).toBe(false);
    const first = draft.routes[0];
    if (!first) throw new Error('no route');
    first.targets = moveItem(first.targets, 0, 1);
    expect(isDirty(draft, routes, 'auto')).toBe(true);
    expect(isDirty(toDraft(routes, 'fast'), routes, 'auto')).toBe(true);
  });

  it('suggests free route names', () => {
    expect(suggestRouteName([])).toBe('route-1');
    const draft = toDraft(routes, 'auto');
    expect(suggestRouteName(draft.routes)).toBe('route-3');
    draft.routes.push(newRoute('route-3'));
    expect(suggestRouteName(draft.routes)).toBe('route-4');
  });
});

describe('validateDraft', () => {
  const valid = () => toDraft(routes, 'auto');

  it('accepts a good draft', () => {
    expect(validateDraft(valid(), accounts).valid).toBe(true);
  });

  it('validates names', () => {
    const d = valid();
    const [a, b] = d.routes;
    if (!a || !b) throw new Error('routes');
    a.name = 'Bad Name';
    expect(validateDraft(d, accounts).byRoute[a.key]?.name).toMatch(/Lowercase/);
    a.name = '';
    expect(validateDraft(d, accounts).byRoute[a.key]?.name).toMatch(/Give/);
    a.name = 'fast';
    const v = validateDraft(d, accounts);
    expect(v.byRoute[a.key]?.name).toMatch(/already uses/);
    expect(v.byRoute[b.key]?.name).toMatch(/already uses/);
    expect(v.valid).toBe(false);
  });

  it('requires targets with models and consistent pinned accounts', () => {
    const d = valid();
    const a = d.routes[0];
    if (!a) throw new Error('route');
    const [t1, t2] = a.targets;
    if (!t1 || !t2) throw new Error('targets');
    t1.model = '  ';
    t2.accountId = 'acc_2';
    let v = validateDraft(d, accounts);
    expect(v.byRoute[a.key]?.target[t1.key]?.model).toBeTruthy();
    expect(v.byRoute[a.key]?.target[t2.key]?.accountId).toMatch(/different provider/);
    t2.accountId = 'acc_gone';
    v = validateDraft(d, accounts);
    expect(v.byRoute[a.key]?.target[t2.key]?.accountId).toMatch(/no longer exists/);
    a.targets = [];
    v = validateDraft(d, accounts);
    expect(v.byRoute[a.key]?.targets).toMatch(/at least one/);
    expect(v.valid).toBe(false);
  });

  it('requires a default route among the routes', () => {
    const d: RoutesDraft = { ...valid(), defaultKey: null };
    const v = validateDraft(d, accounts);
    expect(v.defaultRoute).toBeTruthy();
    expect(v.valid).toBe(false);
    // No routes at all is fine: there is nothing to be the default.
    expect(validateDraft({ routes: [], defaultKey: null }, accounts).valid).toBe(true);
  });
});
