import { describe, expect, it } from 'vitest';
import type { ProviderKind } from '../types';
import {
  API_CONFIG_KEYS,
  apiConfigIssues,
  endpointChanged,
  endpointRebindIssue,
  mergeApiConfig,
} from './account-config';

describe('apiConfigIssues', () => {
  it('never allows executable settings for any provider', () => {
    for (const provider of Object.keys(API_CONFIG_KEYS) as ProviderKind[]) {
      expect(API_CONFIG_KEYS[provider]).not.toContain('binaryPath');
      expect(API_CONFIG_KEYS[provider]).not.toContain('binaryArgs');
      expect(apiConfigIssues(provider, { binaryPath: 'x' })).toHaveLength(1);
      expect(apiConfigIssues(provider, { binaryArgs: ['x'] })).toHaveLength(1);
    }
  });

  it('accepts the documented keys with valid values', () => {
    expect(
      apiConfigIssues('openai-compatible', {
        baseUrl: 'https://example.com/v1',
        models: ['a', 'b'],
        defaultModel: 'a',
        includeUsage: false,
      }),
    ).toEqual([]);
    expect(apiConfigIssues('claude-cli', { models: ['sonnet'] })).toEqual([]);
  });

  it('rejects a base URL on providers that have no endpoint setting', () => {
    expect(apiConfigIssues('claude-cli', { baseUrl: 'https://example.com' })).toHaveLength(1);
  });

  it('rejects malformed values', () => {
    expect(apiConfigIssues('openai', { baseUrl: 'ftp://example.com' })).toHaveLength(1);
    expect(apiConfigIssues('openai', { baseUrl: 42 })).toHaveLength(1);
    expect(apiConfigIssues('openai', { models: [1] })).toHaveLength(1);
    expect(apiConfigIssues('openai', { includeUsage: 'no' })).toHaveLength(1);
  });

  it('tolerates a disallowed key only when it equals the stored value', () => {
    const existing = { binaryPath: '/opt/claude' };
    expect(apiConfigIssues('claude-cli', { binaryPath: '/opt/claude' }, existing)).toEqual([]);
    expect(apiConfigIssues('claude-cli', { binaryPath: '/bin/sh' }, existing)).toHaveLength(1);
  });
});

describe('mergeApiConfig', () => {
  it('replaces API-writable keys and keeps the rest', () => {
    expect(
      mergeApiConfig(
        'claude-cli',
        { binaryPath: '/opt/claude', models: ['old'] },
        { models: ['new'] },
      ),
    ).toEqual({ binaryPath: '/opt/claude', models: ['new'] });
  });

  it('drops an API-writable key that the patch leaves out', () => {
    expect(
      mergeApiConfig(
        'openai-compatible',
        { baseUrl: 'http://a/v1', models: ['m'] },
        { models: ['m'] },
      ),
    ).toEqual({ models: ['m'] });
  });
});

describe('endpoint binding', () => {
  it('ignores trailing slashes and whitespace when comparing endpoints', () => {
    expect(endpointChanged({ baseUrl: 'http://a/v1' }, { baseUrl: ' http://a/v1/ ' })).toBe(false);
    expect(endpointChanged({ baseUrl: 'http://a/v1' }, { baseUrl: 'http://b/v1' })).toBe(true);
    expect(endpointChanged({ baseUrl: 'http://a/v1' }, {})).toBe(true);
    expect(endpointChanged({}, {})).toBe(false);
  });

  it('requires the secret when a stored secret would follow a changed endpoint', () => {
    const existing = { config: { baseUrl: 'http://a/v1' }, hasSecret: true };
    const moved = { baseUrl: 'http://b/v1' };
    expect(endpointRebindIssue(existing, moved, false)).toMatch(/secret/);
    expect(endpointRebindIssue(existing, moved, true)).toBeUndefined();
    expect(endpointRebindIssue(existing, { baseUrl: 'http://a/v1' }, false)).toBeUndefined();
    expect(endpointRebindIssue(existing, undefined, false)).toBeUndefined();
    expect(
      endpointRebindIssue({ config: existing.config, hasSecret: false }, moved, false),
    ).toBeUndefined();
  });
});
