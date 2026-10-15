import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli, type TempDir, tempDir } from '../test-utils';
import { subscriptionFromFlags } from './accounts';

let tmp: TempDir;
let home: string;

beforeEach(() => {
  tmp = tempDir();
  home = join(tmp.path, 'home');
  mkdirSync(home);
});
afterEach(() => tmp.cleanup());

const SECRET = 'sk-do-not-print-me';

describe('davecode accounts plan + budget (local)', () => {
  it('records a plan, shows it in the budget and clears it', async () => {
    const added = await cli(
      [
        'accounts',
        'add',
        '--provider',
        'openai',
        '--label',
        'plus',
        '--secret-env',
        'KEY',
        '--limit',
        'requestsDaily=100',
        '--yes',
        '--local',
        '--json',
      ],
      { home, env: { KEY: SECRET } },
    );
    expect(added.code).toBe(0);
    const { account } = JSON.parse(added.stdout);

    const set = await cli(
      [
        'accounts',
        'plan',
        'plus',
        '--plan',
        'ChatGPT Plus',
        '--price',
        '20',
        '--renews',
        '2099-01-01',
        '--local',
      ],
      { home },
    );
    expect(set.code).toBe(0);
    expect(set.stdout).toContain('plus: ChatGPT Plus · 20 USD/month · renews 2099-01-01');

    const shown = await cli(['accounts', 'plan', account.id, '--local'], { home });
    expect(shown.stdout).toContain('ChatGPT Plus');

    const budget = await cli(['budget', '--local'], { home });
    expect(budget.code).toBe(0);
    expect(budget.stdout).toMatch(/ACCOUNT\s+PROVIDER\s+PLAN\s+RENEWS\s+LEFT\s+STATE/);
    expect(budget.stdout).toContain('ChatGPT Plus 20 USD/month');
    expect(budget.stdout).toContain('100%');
    expect(budget.stdout).toContain('available');
    expect(budget.stdout + budget.stderr).not.toContain(SECRET);

    const context = await cli(['budget', '--context', '--local'], { home });
    expect(context.stdout).toContain('ACCOUNT BUDGET');
    expect(context.stdout).toContain('- plus [openai] (ChatGPT Plus, 20 USD/month, renews in');

    const json = JSON.parse((await cli(['--json', 'budget', '--local'], { home })).stdout);
    expect(json.budget.accounts[0]).toMatchObject({ accountId: account.id, remaining: 1 });

    const bad = await cli(['accounts', 'plan', 'plus', '--renews', 'soon', '--local'], { home });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('Invalid account');

    const cleared = await cli(['accounts', 'plan', 'plus', '--clear', '--local'], { home });
    expect(cleared.stdout).toContain('no plan recorded');
  });
});

describe('subscriptionFromFlags', () => {
  it('merges flags into the existing plan and validates the price', () => {
    const existing = {
      plan: 'Pro',
      price: { amount: 20, currency: 'EUR', period: 'month' as const },
    };
    expect(subscriptionFromFlags(existing, { price: '200', period: 'year' })).toEqual({
      plan: 'Pro',
      price: { amount: 200, currency: 'EUR', period: 'year' },
    });
    expect(() => subscriptionFromFlags(undefined, { price: 'lots' })).toThrow(/--price/);
    expect(() => subscriptionFromFlags(undefined, { price: '5', period: 'week' })).toThrow(
      /--period/,
    );
  });
});
