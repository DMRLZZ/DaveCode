import { describe, expect, it } from 'vitest';
import { CliError } from '../errors';
import {
  accountFromFlags,
  accountInteractively,
  accountPolicy,
  describeCreate,
  parseLimits,
} from './account-flow';
import { scriptedPrompter } from './prompter';

const sources = (env: NodeJS.ProcessEnv = {}, stdin = '') => ({
  env,
  readStdin: async () => stdin,
});
const OFF = { experimental: { geminiWeb: false, multiAccountRotation: false } };
const ON = { experimental: { geminiWeb: true, multiAccountRotation: true } };

describe('accountFromFlags', () => {
  it('builds an API-key account from an environment variable', async () => {
    const create = await accountFromFlags(
      { provider: 'anthropic', label: 'work', priority: 10, secretEnv: 'KEY' },
      sources({ KEY: ' sk-ant-123 ' }),
    );
    expect(create).toEqual({
      provider: 'anthropic',
      label: 'work',
      priority: 10,
      config: {},
      secret: 'sk-ant-123',
    });
  });

  it('reads the secret from stdin and defaults the label', async () => {
    const create = await accountFromFlags(
      { provider: 'openai', secretStdin: true },
      sources({}, 'sk-openai\n'),
    );
    expect(create.label).toBe('OpenAI');
    expect(create.secret).toBe('sk-openai');
  });

  it('requires a key for API providers and a base URL for openai-compatible', async () => {
    await expect(accountFromFlags({ provider: 'gemini' }, sources())).rejects.toThrow(
      /needs an API key/,
    );
    await expect(accountFromFlags({ provider: 'openai-compatible' }, sources())).rejects.toThrow(
      /--base-url/,
    );
    await expect(
      accountFromFlags({ provider: 'openai-compatible', baseUrl: 'ftp://x' }, sources()),
    ).rejects.toThrow(/http/);
  });

  it('configures openai-compatible models without a key', async () => {
    const create = await accountFromFlags(
      {
        provider: 'openai-compatible',
        baseUrl: 'http://localhost:11434/v1/',
        model: ['qwen3:32b', 'llama4', 'qwen3:32b'],
        limit: ['tpm=1000', 'tokens5H=50000'],
      },
      sources(),
    );
    expect(create.config).toEqual({
      baseUrl: 'http://localhost:11434/v1',
      models: ['qwen3:32b', 'llama4'],
    });
    expect(create.limits).toEqual({ tpm: 1000, tokens5h: 50000 });
    expect(create.secret).toBeUndefined();
  });

  it('rejects unknown providers, conflicting secret sources and secrets for CLI logins', async () => {
    await expect(accountFromFlags({ provider: 'nope' }, sources())).rejects.toBeInstanceOf(
      CliError,
    );
    await expect(
      accountFromFlags({ provider: 'openai', secret: 'a', secretEnv: 'B' }, sources({ B: 'b' })),
    ).rejects.toThrow(/only one/);
    await expect(
      accountFromFlags({ provider: 'claude-cli', secret: 'x' }, sources()),
    ).rejects.toThrow(/do not take a secret/);
  });

  it('keeps the CLI binary path for subscription providers', async () => {
    const create = await accountFromFlags(
      { provider: 'codex-cli', binaryPath: '/opt/codex', disabled: true },
      sources(),
    );
    expect(create).toMatchObject({ config: { binaryPath: '/opt/codex' }, enabled: false });
  });
});

describe('parseLimits', () => {
  it('rejects unknown keys and non-positive values', () => {
    expect(() => parseLimits(['bogus=1'])).toThrow(/Unknown limit/);
    expect(() => parseLimits(['rpm=0'])).toThrow(/positive integer/);
  });
});

describe('accountPolicy', () => {
  it('blocks gemini-web unless the experimental flag is on', () => {
    expect(accountPolicy('gemini-web', OFF, []).blocked?.message).toMatch(/Terms of Service/);
    const allowed = accountPolicy('gemini-web', ON, []);
    expect(allowed.blocked).toBeUndefined();
    expect(allowed.warnings).toHaveLength(1);
  });

  it('blocks a second subscription login of the same provider without multiAccountRotation', () => {
    const existing = [{ provider: 'claude-cli' as const }];
    expect(accountPolicy('claude-cli', OFF, existing).blocked?.hint).toMatch(
      /multiAccountRotation/,
    );
    expect(accountPolicy('codex-cli', OFF, existing).blocked).toBeUndefined();
    expect(accountPolicy('anthropic', OFF, [{ provider: 'anthropic' }]).blocked).toBeUndefined();
    expect(accountPolicy('claude-cli', ON, existing).warnings[0]).toMatch(/consumer terms/);
  });
});

describe('accountInteractively', () => {
  it('walks provider, label, priority, base URL, models and a masked key', async () => {
    const prompter = scriptedPrompter([
      'openai-compatible',
      'OpenRouter',
      '5',
      'https://openrouter.ai/api/v1',
      'openai/gpt-5.5, anthropic/claude-sonnet-5-5',
      'sk-or-secret',
      true,
    ]);
    const said: string[] = [];
    const create = await accountInteractively(
      {},
      { prompter, config: OFF, existing: [], say: (l) => said.push(l) },
    );
    expect(create).toEqual({
      provider: 'openai-compatible',
      label: 'OpenRouter',
      priority: 5,
      config: {
        baseUrl: 'https://openrouter.ai/api/v1',
        models: ['openai/gpt-5.5', 'anthropic/claude-sonnet-5-5'],
      },
      secret: 'sk-or-secret',
    });
    expect(said.join('\n')).not.toContain('sk-or-secret');
    expect(said.join('\n')).toContain('secret    set (stored encrypted)');
  });

  it('suggests a unique label and skips questions answered by flags', async () => {
    const prompter = scriptedPrompter([true, '', true]);
    const create = await accountInteractively(
      { provider: 'claude-cli', priority: 1 },
      {
        prompter,
        config: ON,
        existing: [{ provider: 'claude-cli', label: 'Claude Code' }],
        say: () => {},
      },
    );
    // The ToS confirmation for rotation is asked first, then the label (default accepted).
    expect(prompter.asked).toEqual([
      'I understand the risk. Continue?',
      'Label',
      'Add this account?',
    ]);
    expect(create?.label).toBe('Claude Code 2');
  });

  it('returns undefined when the ToS warning is declined', async () => {
    const prompter = scriptedPrompter([false]);
    const create = await accountInteractively(
      { provider: 'gemini-web' },
      { prompter, config: ON, existing: [], say: () => {} },
    );
    expect(create).toBeUndefined();
  });

  it('refuses gemini-web before asking anything when the flag is off', async () => {
    const prompter = scriptedPrompter([]);
    await expect(
      accountInteractively(
        { provider: 'gemini-web' },
        { prompter, config: OFF, existing: [], say: () => {} },
      ),
    ).rejects.toThrow(/experimental/);
  });
});

describe('describeCreate', () => {
  it('never includes the secret value', () => {
    const lines = describeCreate({ provider: 'openai', label: 'x', secret: 'sk-top-secret' });
    expect(lines.join('\n')).not.toContain('sk-top-secret');
  });
});
