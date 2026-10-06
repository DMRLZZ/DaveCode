import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, deepMerge, loadConfig } from './loader';

let home: string;
let project: string;

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'davecode-home-'));
  project = mkdtempSync(join(tmpdir(), 'davecode-project-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('deepMerge', () => {
  it('merges nested objects and replaces arrays', () => {
    const merged = deepMerge(
      { a: { b: 1, c: [1, 2] }, d: 'x' },
      { a: { c: [3], e: true }, d: undefined },
    );
    expect(merged).toEqual({ a: { b: 1, c: [3], e: true }, d: 'x' });
  });
});

describe('loadConfig', () => {
  it('returns defaults when no files or env vars exist', () => {
    const config = loadConfig({ home, projectRoot: project, env: {} });
    expect(config.server.port).toBe(4040);
    expect(config.experimental.geminiWeb).toBe(false);
  });

  it('layers global, project and env (later wins)', () => {
    writeJson(join(home, 'config.json'), {
      server: { port: 5000, host: '0.0.0.0' },
      routing: { routes: [{ name: 'a', targets: [{ provider: 'openai', model: 'gpt-x' }] }] },
      logLevel: 'debug',
    });
    writeJson(join(project, '.davecode', 'config.json'), {
      server: { port: 6000 },
      routing: { routes: [{ name: 'b', targets: [{ provider: 'anthropic', model: 'claude' }] }] },
    });
    const config = loadConfig({
      home,
      projectRoot: project,
      env: { DAVECODE_PORT: '7000', DAVECODE_EXPERIMENTAL_GEMINI_WEB: 'true' },
    });
    expect(config.server.port).toBe(7000);
    expect(config.server.host).toBe('0.0.0.0');
    expect(config.logLevel).toBe('debug');
    // Arrays replace rather than concatenate.
    expect(config.routing.routes.map((r) => r.name)).toEqual(['b']);
    expect(config.experimental.geminiWeb).toBe(true);
    expect(config.experimental.multiAccountRotation).toBe(false);
  });

  it('reads every supported env var', () => {
    const config = loadConfig({
      home,
      env: {
        DAVECODE_HOST: '0.0.0.0',
        DAVECODE_PORT: '1234',
        DAVECODE_AUTH_TOKEN: 'tok',
        DAVECODE_LOG_LEVEL: 'WARN',
        DAVECODE_EXPERIMENTAL_GEMINI_WEB: '1',
        DAVECODE_EXPERIMENTAL_MULTI_ACCOUNT_ROTATION: 'yes',
      },
    });
    expect(config.server).toMatchObject({ host: '0.0.0.0', port: 1234, authToken: 'tok' });
    expect(config.logLevel).toBe('warn');
    expect(config.experimental).toEqual({ geminiWeb: true, multiAccountRotation: true });
  });

  it('uses DAVECODE_HOME from env when home is not given', () => {
    writeJson(join(home, 'config.json'), { server: { port: 4141 } });
    expect(loadConfig({ env: { DAVECODE_HOME: home } }).server.port).toBe(4141);
  });

  it('applies programmatic overrides last', () => {
    const config = loadConfig({
      home,
      env: { DAVECODE_PORT: '7000' },
      overrides: { server: { port: 8000 } },
    });
    expect(config.server.port).toBe(8000);
  });

  it('reports malformed JSON with the file path', () => {
    const path = join(home, 'config.json');
    writeJson(path, '{ not json');
    expect(() => loadConfig({ home, env: {} })).toThrow(ConfigError);
    expect(() => loadConfig({ home, env: {} })).toThrow(path);
  });

  it('reports schema violations with the file path and field', () => {
    const path = join(project, '.davecode', 'config.json');
    writeJson(path, { server: { port: 'nope' } });
    try {
      loadConfig({ home, projectRoot: project, env: {} });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).source).toBe(path);
      expect((err as Error).message).toContain('server.port');
    }
  });

  it('rejects non-object JSON', () => {
    writeJson(join(home, 'config.json'), '[1,2]');
    expect(() => loadConfig({ home, env: {} })).toThrow(/expected a JSON object/);
  });

  it('rejects invalid env values with the variable name', () => {
    expect(() => loadConfig({ home, env: { DAVECODE_PORT: '99999' } })).toThrow(/DAVECODE_PORT/);
    expect(() => loadConfig({ home, env: { DAVECODE_EXPERIMENTAL_GEMINI_WEB: 'maybe' } })).toThrow(
      /DAVECODE_EXPERIMENTAL_GEMINI_WEB/,
    );
    expect(() => loadConfig({ home, env: { DAVECODE_LOG_LEVEL: 'loud' } })).toThrow(
      /DAVECODE_LOG_LEVEL/,
    );
  });
});
