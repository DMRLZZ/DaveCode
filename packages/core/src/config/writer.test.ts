import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngine } from '../engine';
import { FakeProvider } from '../router/testing';
import type { ProviderKind, Route } from '../types';
import { ConfigError, loadConfig } from './loader';
import { projectOverridesRouting, writeGlobalRouting } from './writer';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'davecode-writer-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const configPath = () => join(home, 'config.json');
const readConfig = () => JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>;

const fast: Route = {
  name: 'fast',
  description: 'cheap and quick',
  targets: [
    { provider: 'openai', model: 'gpt-mini' },
    { provider: 'anthropic', model: 'claude-haiku', accountId: 'acc_1' },
  ],
};

describe('writeGlobalRouting', () => {
  it('creates the file when it does not exist', async () => {
    const result = await writeGlobalRouting(home, { routes: [fast], defaultRoute: 'fast' });
    expect(result).toMatchObject({ path: configPath(), defaultRoute: 'fast', routes: [fast] });
    expect(readConfig()).toEqual({ routing: { routes: [fast], defaultRoute: 'fast' } });
    expect(loadConfig({ home, env: {} }).routing.routes).toEqual([fast]);
  });

  it('preserves every other key, including the rest of routing', async () => {
    writeFileSync(
      configPath(),
      JSON.stringify({
        server: { port: 5000, authToken: 'secret-token' },
        logLevel: 'debug',
        routing: {
          defaultRoute: 'auto',
          maxFailovers: 2,
          routes: [{ name: 'old', targets: [{ provider: 'openai', model: 'x' }] }],
        },
        runner: { maxRepairCycles: 1 },
      }),
    );
    await writeGlobalRouting(home, { routes: [fast] });
    const written = readConfig();
    expect(written).toEqual({
      server: { port: 5000, authToken: 'secret-token' },
      logLevel: 'debug',
      routing: { defaultRoute: 'auto', maxFailovers: 2, routes: [fast] },
      runner: { maxRepairCycles: 1 },
    });
  });

  it('leaves no temp or lock files behind and ends with a newline', async () => {
    await writeGlobalRouting(home, { routes: [fast] });
    await writeGlobalRouting(home, { routes: [] });
    expect(readdirSync(home)).toEqual(['config.json']);
    expect(readFileSync(configPath(), 'utf8').endsWith('}\n')).toBe(true);
  });

  it('serialises concurrent writers without corrupting the file', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        writeGlobalRouting(home, {
          routes: [{ name: `r${i}`, targets: [{ provider: 'openai', model: `m${i}` }] }],
        }),
      ),
    );
    const routes = (readConfig().routing as { routes: Route[] }).routes;
    expect(routes).toHaveLength(1);
    expect(loadConfig({ home, env: {} }).routing.routes).toEqual(routes);
  });

  it('refuses to overwrite a malformed or invalid file', async () => {
    writeFileSync(configPath(), '{ not json');
    await expect(writeGlobalRouting(home, { routes: [fast] })).rejects.toBeInstanceOf(ConfigError);
    expect(readFileSync(configPath(), 'utf8')).toBe('{ not json');

    writeFileSync(configPath(), '[]');
    await expect(writeGlobalRouting(home, { routes: [fast] })).rejects.toThrow(/JSON object/);
    expect(readFileSync(configPath(), 'utf8')).toBe('[]');
  });

  it('rejects routes that do not match the config schema, writing nothing', async () => {
    writeFileSync(configPath(), '{"logLevel":"info"}');
    const bad = { name: 'Bad Name', targets: [] } as unknown as Route;
    await expect(writeGlobalRouting(home, { routes: [bad] })).rejects.toBeInstanceOf(ConfigError);
    expect(readFileSync(configPath(), 'utf8')).toBe('{"logLevel":"info"}');
  });
});

describe('projectOverridesRouting', () => {
  it('detects a project config that sets routes or defaultRoute', async () => {
    const project = mkdtempSync(join(tmpdir(), 'davecode-writer-project-'));
    try {
      expect(await projectOverridesRouting(project)).toBe(false);
      mkdirSync(join(project, '.davecode'));
      const file = join(project, '.davecode', 'config.json');
      writeFileSync(file, JSON.stringify({ logLevel: 'debug' }));
      expect(await projectOverridesRouting(project)).toBe(false);
      writeFileSync(file, JSON.stringify({ routing: { maxFailovers: 1 } }));
      expect(await projectOverridesRouting(project)).toBe(false);
      writeFileSync(file, JSON.stringify({ routing: { defaultRoute: 'x' } }));
      expect(await projectOverridesRouting(project)).toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('Engine.updateRouting', () => {
  it('persists globally and the router uses the new routes immediately', async () => {
    const providers = new Map<ProviderKind, FakeProvider>([
      ['openai', new FakeProvider('openai', ['gpt-mini', 'gpt-big'])],
      ['anthropic', new FakeProvider('anthropic', ['claude-haiku'])],
    ]);
    const engine = createEngine({ home, env: {}, providers, databasePath: ':memory:' });
    try {
      engine.accounts.create({ provider: 'openai', label: 'o' });
      engine.accounts.create({ provider: 'anthropic', label: 'a' });
      const plan = (model: string) =>
        engine.router
          .plan({ model, messages: [{ role: 'user', content: 'hi' }] })
          .candidates.map((c) => `${c.account.provider}/${c.model}`);

      // Before: `davecode/fast` is unknown, so the implicit default route (no models) is used.
      expect(plan('davecode/fast')).not.toContain('openai/gpt-mini');

      const result = await engine.updateRouting({ routes: [fast], defaultRoute: 'fast' });
      expect(result.shadowedByProject).toBe(false);
      expect(engine.config.routing.routes).toEqual([fast]);
      expect(engine.config.routing.defaultRoute).toBe('fast');
      expect(plan('davecode/fast')).toEqual(['openai/gpt-mini']);
      // The pinned account does not exist, so only the first target resolves; unknown aliases
      // fall back to the (new) default route.
      expect(plan('davecode/whatever')).toEqual(['openai/gpt-mini']);

      expect(readConfig().routing).toEqual({ routes: [fast], defaultRoute: 'fast' });

      // Replacing again and omitting defaultRoute keeps it.
      const second = { name: 'big', targets: [{ provider: 'openai' as const, model: 'gpt-big' }] };
      await engine.updateRouting({ routes: [second] });
      expect(engine.config.routing.defaultRoute).toBe('fast');
      expect(plan('davecode/big')).toEqual(['openai/gpt-big']);
    } finally {
      engine.close();
    }
  });

  it('reports when a project config would shadow the global routes', async () => {
    const project = mkdtempSync(join(tmpdir(), 'davecode-writer-project-'));
    try {
      mkdirSync(join(project, '.davecode'));
      writeFileSync(
        join(project, '.davecode', 'config.json'),
        JSON.stringify({ routing: { defaultRoute: 'proj' } }),
      );
      const engine = createEngine({
        home,
        env: {},
        projectRoot: project,
        databasePath: ':memory:',
      });
      try {
        expect((await engine.updateRouting({ routes: [fast] })).shadowedByProject).toBe(true);
      } finally {
        engine.close();
      }
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
