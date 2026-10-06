import { describe, expect, it } from 'vitest';
import type { Account, ProviderKind, Route } from '../types';
import {
  accountServes,
  defaultModelFor,
  inferProviders,
  parseModel,
  resolveCandidates,
} from './candidates';

function account(
  id: string,
  provider: ProviderKind,
  config: Record<string, unknown> = {},
): Account {
  return {
    id,
    provider,
    label: id,
    enabled: true,
    priority: 100,
    weight: 1,
    limits: {},
    config,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const routes: Route[] = [
  {
    name: 'auto',
    targets: [
      { provider: 'anthropic', model: 'claude-x' },
      { provider: 'openai', model: 'gpt-x' },
    ],
  },
  { name: 'pinned', targets: [{ provider: 'openai', model: 'gpt-x', accountId: 'o2' }] },
];

describe('parseModel', () => {
  it('resolves configured routes and falls back to the default route', () => {
    expect(parseModel('davecode/pinned', routes, 'auto')).toMatchObject({
      kind: 'route',
      name: 'pinned',
    });
    expect(parseModel('davecode/unknown', routes, 'auto')).toMatchObject({
      kind: 'route',
      name: 'auto',
    });
    expect(parseModel('davecode/auto', [], 'auto')).toEqual({ kind: 'route', name: 'auto' });
  });

  it('parses provider prefixes and bare models', () => {
    expect(parseModel('anthropic/claude-x', routes, 'auto')).toEqual({
      kind: 'provider',
      provider: 'anthropic',
      model: 'claude-x',
    });
    expect(parseModel('openai-compatible/meta-llama/llama-3', routes, 'auto')).toEqual({
      kind: 'provider',
      provider: 'openai-compatible',
      model: 'meta-llama/llama-3',
    });
    expect(parseModel('meta-llama/llama-3', routes, 'auto')).toEqual({
      kind: 'model',
      model: 'meta-llama/llama-3',
    });
    expect(parseModel('openai/', routes, 'auto')).toEqual({ kind: 'model', model: 'openai/' });
    expect(parseModel('gpt-x', routes, 'auto')).toEqual({ kind: 'model', model: 'gpt-x' });
  });
});

describe('model matching', () => {
  it('infers provider families', () => {
    expect(inferProviders('claude-sonnet')).toEqual(['anthropic', 'claude-cli']);
    expect(inferProviders('gpt-5')).toEqual(['openai', 'codex-cli']);
    expect(inferProviders('o3-mini')).toEqual(['openai', 'codex-cli']);
    expect(inferProviders('gemini-2.5-pro')).toEqual(['gemini', 'gemini-web']);
    expect(inferProviders('llama3')).toEqual([]);
  });

  it('honours allow-lists, provider prefixes and inference', () => {
    const listed = account('a', 'openai', { models: ['gpt-x'] });
    expect(accountServes(listed, 'gpt-x')).toBe(true);
    expect(accountServes(listed, 'gpt-y')).toBe(false);
    expect(accountServes(listed, 'gpt-x', 'anthropic')).toBe(false);

    const open = account('b', 'anthropic');
    expect(accountServes(open, 'anything', 'anthropic')).toBe(true);
    expect(accountServes(open, 'claude-z')).toBe(true);
    expect(accountServes(open, 'gpt-x')).toBe(false);

    const compat = account('c', 'openai-compatible');
    expect(accountServes(compat, 'llama3')).toBe(true);
    expect(accountServes(compat, 'claude-z')).toBe(false);
  });

  it('picks the default model from config', () => {
    expect(defaultModelFor(account('a', 'openai', { defaultModel: 'm1', models: ['m2'] }))).toBe(
      'm1',
    );
    expect(defaultModelFor(account('a', 'openai', { models: ['m2', 'm3'] }))).toBe('m2');
    expect(defaultModelFor(account('a', 'openai', { models: [1, ''] }))).toBeUndefined();
  });
});

describe('resolveCandidates', () => {
  const accounts = [
    account('a1', 'anthropic'),
    account('o1', 'openai'),
    account('o2', 'openai', { models: ['gpt-x', 'gpt-y'], defaultModel: 'gpt-y' }),
  ];

  it('expands route targets in order and honours pinned accounts', () => {
    const auto = resolveCandidates(parseModel('davecode/auto', routes, 'auto'), accounts);
    expect(auto.map((c) => [c.account.id, c.model, c.targetIndex])).toEqual([
      ['a1', 'claude-x', 0],
      ['o1', 'gpt-x', 1],
      ['o2', 'gpt-x', 1],
    ]);
    const pinned = resolveCandidates(parseModel('davecode/pinned', routes, 'auto'), accounts);
    expect(pinned.map((c) => c.account.id)).toEqual(['o2']);
  });

  it('uses each account default model for the implicit default route', () => {
    const implicit = resolveCandidates(parseModel('davecode/auto', [], 'auto'), accounts);
    expect(implicit.map((c) => [c.account.id, c.model])).toEqual([['o2', 'gpt-y']]);
  });

  it('matches provider-prefixed and bare models', () => {
    expect(
      resolveCandidates(parseModel('openai/gpt-z', [], 'auto'), accounts).map((c) => c.account.id),
    ).toEqual(['o1']);
    expect(
      resolveCandidates(parseModel('gpt-y', [], 'auto'), accounts).map((c) => c.account.id),
    ).toEqual(['o1', 'o2']);
    expect(resolveCandidates(parseModel('mystery', [], 'auto'), accounts)).toEqual([]);
  });
});
