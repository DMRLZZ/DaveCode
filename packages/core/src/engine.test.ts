import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngine } from './engine';
import { PROVIDER_KINDS } from './router/candidates';
import { FakeProvider } from './router/testing';
import type { ProviderKind } from './types';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'davecode-engine-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('createEngine', () => {
  it('wires storage, identity and quotas under the given home', () => {
    const engine = createEngine({ home, env: {} });
    try {
      expect(engine.home).toBe(home);
      // Every built-in adapter is registered by default.
      expect([...engine.providers.keys()].sort()).toEqual([...PROVIDER_KINDS].sort());
      expect(engine.config.server.port).toBe(4040);
      expect(existsSync(join(home, 'state.db'))).toBe(true);
      expect(existsSync(join(home, 'master.key'))).toBe(true);
      expect(engine.sandboxes.root).toBe(join(home, 'sandboxes'));
      expect(engine.chromium.root).toBe(join(home, 'profiles'));
      const account = engine.accounts.create({ provider: 'openai', label: 'x' });
      engine.keyring.set(account.id, 'sk-1');
      expect(engine.keyring.get(account.id)).toBe('sk-1');
    } finally {
      engine.close();
      engine.close(); // idempotent
    }
  });

  it('resolves home from env and layers project config and overrides', () => {
    const project = mkdtempSync(join(tmpdir(), 'davecode-engine-project-'));
    try {
      mkdirSync(join(project, '.davecode'), { recursive: true });
      writeFileSync(
        join(project, '.davecode', 'config.json'),
        JSON.stringify({ server: { port: 5000 }, logLevel: 'debug' }),
      );
      const engine = createEngine({
        env: { DAVECODE_HOME: home, DAVECODE_EXPERIMENTAL_GEMINI_WEB: 'true' },
        projectRoot: project,
        config: { server: { port: 6000 } },
        databasePath: ':memory:',
      });
      expect(engine.home).toBe(home);
      expect(engine.projectRoot).toBe(project);
      expect(engine.config.server.port).toBe(6000);
      expect(engine.config.logLevel).toBe('debug');
      expect(engine.config.experimental.geminiWeb).toBe(true);
      engine.close();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('routes through injected providers and rehydrates quotas after a restart', async () => {
    const providers = new Map<ProviderKind, FakeProvider>([['openai', new FakeProvider('openai')]]);
    const first = createEngine({ home, env: {}, providers });
    const account = first.accounts.create({ provider: 'openai', label: 'x' });
    const { meta } = await first.router.complete({
      model: 'openai/gpt-x',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(meta.accountId).toBe(account.id);
    const before = first.quota.usage(account).windows['24h'];
    expect(before.requests).toBe(1);
    first.close();

    const second = createEngine({ home, env: {} });
    expect(second.quota.usage(account).windows['24h']).toEqual(before);
    second.close();
  });
});
