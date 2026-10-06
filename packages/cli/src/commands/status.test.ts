import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Account, type AccountUsage, createEngine } from '@davecode/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startRuntime } from '../runtime';
import { cli, plain, type TempDir, tempDir, testEnv } from '../test-utils';
import { renderStatus, type StatusReport, windowCell } from './status';

let tmp: TempDir;
let home: string;

beforeEach(() => {
  tmp = tempDir();
  home = join(tmp.path, 'home');
  mkdirSync(home);
});
afterEach(() => tmp.cleanup());

function seedAccount(label = 'work'): Account {
  const engine = createEngine({ home, env: testEnv(home) });
  try {
    return engine.accounts.create({
      provider: 'anthropic',
      label,
      limits: { tokens5h: 1000 },
    });
  } finally {
    engine.close();
  }
}

const usage = (accountId: string, ratio: number): AccountUsage => ({
  accountId,
  windows: {
    '1m': { window: '1m', tokens: 10, requests: 1, utilization: 0 },
    '5h': {
      window: '5h',
      tokens: ratio * 1000,
      requests: 1,
      tokenLimit: 1000,
      utilization: ratio,
    },
    '24h': { window: '24h', tokens: 12_300, requests: 1, utilization: 0 },
  },
});

describe('status rendering', () => {
  it('draws bars for limited windows and raw tokens for unlimited ones', () => {
    const u = usage('acc_1', 0.5);
    expect(windowCell(plain, u.windows['5h'], 4)).toBe('██░░ 50%');
    expect(windowCell(plain, u.windows['24h'], 4)).toBe('░░░░ 12.3k');
  });

  it('renders a running gateway with accounts and experimental warnings', () => {
    const account: Account = {
      id: 'acc_1',
      provider: 'claude-cli',
      label: 'work',
      enabled: true,
      priority: 100,
      weight: 1,
      limits: {},
      config: {},
      status: 'cooldown',
      lastError: 'rate limited',
      createdAt: '',
      updatedAt: '',
    };
    const report: StatusReport = {
      running: true,
      source: 'gateway',
      url: 'http://127.0.0.1:4040',
      version: '0.1.0',
      uptimeSec: 125,
      experimental: { geminiWeb: false, multiAccountRotation: true },
      home,
      accounts: [{ account, usage: usage('acc_1', 0.95) }],
    };
    const text = renderStatus(plain, report, 120).join('\n');
    expect(text).toContain('● running  http://127.0.0.1:4040  v0.1.0 · up 2m 5s');
    expect(text).toMatch(/ACCOUNT\s+ID\s+PROVIDER\s+STATUS\s+PRI\s+1M\s+5H\s+24H/);
    expect(text).toContain('cooldown');
    expect(text).toContain('95%');
    expect(text).toContain('! work: rate limited');
    expect(text).toContain('experimental.multiAccountRotation enabled');
  });

  it('drops columns in narrow terminals', () => {
    const report: StatusReport = {
      running: false,
      source: 'local',
      url: 'http://127.0.0.1:4040',
      experimental: { geminiWeb: false, multiAccountRotation: false },
      home,
      accounts: [
        {
          account: {
            id: 'acc_123456789',
            provider: 'openai',
            label: 'personal',
            enabled: true,
            priority: 100,
            weight: 1,
            limits: {},
            config: {},
            status: 'active',
            createdAt: '',
            updatedAt: '',
          },
          usage: usage('acc_123456789', 0.1),
        },
      ],
    };
    const header = renderStatus(plain, report, 40).find((l) => l.startsWith('ACCOUNT'));
    expect(header).toBeDefined();
    expect(header).not.toContain('ID');
    expect(header).toContain('5H');
    expect(header!.length).toBeLessThanOrEqual(40);
  });
});

describe('davecode status', () => {
  it('reads local state when no gateway is running', async () => {
    seedAccount('local-one');
    // Point at a port nothing listens on.
    const res = await cli(['status'], { home, env: { DAVECODE_PORT: '1' } });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('not running');
    expect(res.stdout).toContain('local-one');
  });

  it('prints JSON for scripts', async () => {
    const account = seedAccount();
    const res = await cli(['status', '--json'], { home, env: { DAVECODE_PORT: '1' } });
    const report = JSON.parse(res.stdout);
    expect(report.running).toBe(false);
    expect(report.source).toBe('local');
    expect(report.accounts[0].id).toBe(account.id);
    expect(report.accounts[0].usage.windows['5h'].tokenLimit).toBe(1000);
  });

  it('shows live data from a running gateway', async () => {
    seedAccount('live-one');
    const runtime = await startRuntime({
      home,
      env: testEnv(home),
      cwd: tmp.path,
      host: '127.0.0.1',
      port: 0,
      dashboard: false,
      noProject: true,
    });
    try {
      const res = await cli(['--json', 'status'], {
        home,
        env: { DAVECODE_PORT: String(runtime.port) },
      });
      const report = JSON.parse(res.stdout);
      expect(report.running).toBe(true);
      expect(report.source).toBe('gateway');
      expect(report.url).toBe(runtime.url);
      expect(report.accounts.map((a: Account) => a.label)).toEqual(['live-one']);
    } finally {
      await runtime.close();
    }
  });
});
