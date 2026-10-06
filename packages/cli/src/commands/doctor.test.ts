import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { configSchema } from '@davecode/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContext } from '../context';
import { plain, type TempDir, tempDir, testEnv, testIO } from '../test-utils';
import {
  type DoctorProbes,
  defaultProbes,
  doctorCommand,
  nodeVersionOk,
  renderDoctor,
  runDoctor,
} from './doctor';

let tmp: TempDir;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

function healthyProbes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    nodeVersion: 'v24.1.0',
    loadConfig: () => configSchema.parse({}),
    loadSqlite: async () => 'loads (SQLite 3.50.0)',
    checkWritable: async () => {},
    exists: () => true,
    portInUse: async () => false,
    gatewayVersion: async () => undefined,
    which: (cmd) => `/usr/bin/${cmd}`,
    reachable: async () => true,
    dashboardDir: () => '/opt/davecode/ui',
    ...overrides,
  };
}

const byId = (results: Awaited<ReturnType<typeof runDoctor>>) =>
  Object.fromEntries(results.map((r) => [r.id, r]));

describe('runDoctor', () => {
  it('passes every check on a healthy machine', async () => {
    const results = await runDoctor({ home: '/h', env: {} }, healthyProbes());
    expect(results.every((r) => r.status === 'ok')).toBe(true);
    expect(results.map((r) => r.id)).toEqual([
      'node',
      'config',
      'sqlite',
      'home',
      'master-key',
      'port',
      'git',
      'claude',
      'codex',
      'gh',
      'ollama',
      'dashboard',
    ]);
  });

  it('fails hard problems and warns about optional ones, each with a fix', async () => {
    const results = byId(
      await runDoctor(
        { home: '/h', env: {} },
        healthyProbes({
          nodeVersion: 'v20.11.0',
          loadSqlite: async () => {
            throw new Error('was compiled against a different Node.js version');
          },
          checkWritable: async () => {
            throw Object.assign(new Error('nope'), { code: 'EACCES' });
          },
          exists: () => false,
          which: (cmd) => (cmd === 'git' ? undefined : cmd === 'gh' ? '/bin/gh' : undefined),
          reachable: async () => false,
          dashboardDir: () => undefined,
        }),
      ),
    );
    expect(results.node).toMatchObject({ status: 'fail', fix: expect.stringContaining('22.12') });
    expect(results.sqlite).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('rebuild'),
    });
    expect(results.home).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('EACCES'),
    });
    expect(results['master-key']?.status).toBe('warn');
    expect(results.git?.status).toBe('fail');
    expect(results.claude).toMatchObject({
      status: 'warn',
      fix: 'npm install -g @anthropic-ai/claude-code',
    });
    expect(results.gh?.status).toBe('ok');
    expect(results.ollama).toMatchObject({
      status: 'warn',
      fix: expect.stringContaining('ollama serve'),
    });
    expect(results.dashboard?.status).toBe('warn');
  });

  it('distinguishes a running DaveCode gateway from a foreign process on the port', async () => {
    const ours = byId(
      await runDoctor(
        { home: '/h', env: {} },
        healthyProbes({ portInUse: async () => true, gatewayVersion: async () => '0.1.0' }),
      ),
    );
    expect(ours.port).toMatchObject({
      status: 'ok',
      detail: expect.stringContaining('already running'),
    });
    const foreign = byId(
      await runDoctor({ home: '/h', env: {} }, healthyProbes({ portInUse: async () => true })),
    );
    expect(foreign.port).toMatchObject({
      status: 'fail',
      fix: expect.stringContaining('--port 4041'),
    });
  });

  it('reports config errors and skips the port check', async () => {
    const results = byId(
      await runDoctor(
        { home: '/h', env: {} },
        healthyProbes({
          loadConfig: () => {
            throw new Error('Invalid DaveCode config (/h/config.json):\nmalformed JSON');
          },
        }),
      ),
    );
    expect(results.config?.status).toBe('fail');
    expect(results.port).toBeUndefined();
  });

  it('accepts DAVECODE_MASTER_KEY instead of a key file', async () => {
    const results = byId(
      await runDoctor(
        { home: '/h', env: { DAVECODE_MASTER_KEY: 'x' } },
        healthyProbes({ exists: () => false }),
      ),
    );
    expect(results['master-key']?.detail).toBe('from DAVECODE_MASTER_KEY');
  });

  it('checks the minimum Node version', () => {
    expect(nodeVersionOk('v22.12.0')).toBe(true);
    expect(nodeVersionOk('v22.11.9')).toBe(false);
    expect(nodeVersionOk('v23.0.0')).toBe(true);
  });
});

describe('doctor output', () => {
  it('renders marks, fixes and a summary line', async () => {
    const results = await runDoctor(
      { home: '/h', env: {} },
      healthyProbes({ reachable: async () => false }),
    );
    const text = renderDoctor({ theme: plain }, results).join('\n');
    expect(text).toContain('✓ Node.js');
    expect(text).toContain('! Ollama');
    expect(text).toContain('fix: Start it with `ollama serve`');
    expect(text).toContain('11 ok · 1 warning · 0 failures');
  });

  it('exits 1 on failures and prints JSON', async () => {
    const io = testIO();
    const home = join(tmp.path, 'home');
    const ctx = createContext({ json: true }, io, { env: testEnv(home), cwd: tmp.path });
    const code = await doctorCommand(ctx, healthyProbes({ which: () => undefined }));
    expect(code).toBe(1);
    const report = JSON.parse(io.stdout.text());
    expect(report.ok).toBe(false);
    expect(report.checks.find((c: { id: string }) => c.id === 'git').status).toBe('fail');
  });
});

describe('real probes', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it('loads SQLite, writes the home dir and sees a busy port', async () => {
    const probes = defaultProbes({ home: tmp.path, env: testEnv(tmp.path) });
    expect(await probes.loadSqlite()).toMatch(/SQLite \d+/);
    await expect(probes.checkWritable(join(tmp.path, 'nested'))).resolves.toBeUndefined();

    server = createServer();
    const port = await new Promise<number>((resolve) => {
      server!.listen({ host: '127.0.0.1', port: 0 }, () => {
        resolve((server!.address() as { port: number }).port);
      });
    });
    expect(await probes.portInUse('127.0.0.1', port)).toBe(true);
    expect(await probes.gatewayVersion(`http://127.0.0.1:${port}`)).toBeUndefined();
  });
});
