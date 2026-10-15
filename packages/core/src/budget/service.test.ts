import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../engine';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

let home: string;
let engine: Engine;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'davecode-budget-'));
  engine = createEngine({ home, env: {}, databasePath: ':memory:', clock: () => NOW });
});

afterEach(() => {
  engine.close();
  rmSync(home, { recursive: true, force: true });
});

describe('BudgetService', () => {
  it('combines subscription details, own windows and provider-reported limits', () => {
    const pro = engine.accounts.create({
      provider: 'anthropic',
      label: 'Claude API',
      limits: { tokens5h: 1000 },
      subscription: {
        plan: 'Build tier',
        renewsAt: '2026-10-25',
        price: { amount: 20, currency: 'USD', period: 'month' },
      },
    });
    const open = engine.accounts.create({ provider: 'openai', label: 'OpenAI' });
    const off = engine.accounts.create({ provider: 'gemini', label: 'Gemini', enabled: false });
    engine.quota.record(pro.id, 600);
    engine.reported.report(open.id, { requestsRemaining: 30, requestsLimit: 100 }, 'headers');

    const snapshot = engine.budget.snapshot();
    const byId = new Map(snapshot.accounts.map((a) => [a.accountId, a]));
    expect(byId.get(pro.id)).toMatchObject({
      remaining: 0.4,
      tightestWindow: '5h',
      renewsInDays: 10,
      available: true,
      subscription: { plan: 'Build tier' },
    });
    expect(byId.get(open.id)).toMatchObject({ remaining: 0.3, available: true });
    expect(byId.get(open.id)?.tightestWindow).toBeUndefined();
    expect(byId.get(off.id)).toMatchObject({
      remaining: null,
      available: false,
      unavailableReason: 'disabled',
    });

    expect(snapshot.context).toContain('2 of 2 accounts available');
    expect(snapshot.context).toContain(
      '- Claude API [anthropic] (Build tier, 20 USD/month, renews in 10d): 40% left (5h window)',
    );
    expect(snapshot.context).toContain('- OpenAI [openai]: 30% left (provider-reported)');
    expect(snapshot.context).not.toContain('Gemini');
  });

  it('explains exhausted accounts and never leaks secrets', () => {
    const cli = engine.accounts.create({ provider: 'openai', label: 'Plus' });
    engine.keyring.set(cli.id, 'sk-very-secret-value');
    engine.reported.report(
      cli.id,
      { exhausted: true, resetAt: new Date(NOW + 3_600_000).toISOString() },
      'error',
    );
    const [budget] = engine.budget.snapshot().accounts;
    expect(budget).toMatchObject({
      available: false,
      remaining: 0,
      unavailableReason: 'provider quota exhausted until 2026-10-15 13:00 UTC',
    });
    const context = engine.budget.context();
    expect(context).toContain('0 of 1 accounts available');
    expect(context).toContain('unavailable: provider quota exhausted until 2026-10-15 13:00 UTC');
    expect(JSON.stringify(engine.budget.snapshot())).not.toContain('sk-very-secret-value');
  });

  it('is empty when no account is enabled', () => {
    expect(engine.budget.context()).toBe('');
  });
});
