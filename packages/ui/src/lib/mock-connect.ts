import { providerMeta } from './providers';
import type { Account, AccountConnection, ConnectionMethod } from './types';

/** Seeded CLI-login accounts that already have a vendor login in the mock. */
export const MOCK_LOGGED_IN = new Set(['acc_claude_pro']);

/** How long the simulated vendor sign-in takes after "Connect subscription". */
export const MOCK_LOGIN_MS = 6_000;

function methodOf(account: Account): ConnectionMethod {
  const { auth } = providerMeta(account.provider);
  if (auth === 'cli') return 'cli-login';
  if (auth === 'browser') return 'browser';
  return 'api-key';
}

/** Mirrors the gateway's ConnectionChecker for the mock engine. */
export function mockConnection(
  account: Account,
  loggedIn: boolean,
  now: number,
): AccountConnection {
  const method = methodOf(account);
  const base = {
    accountId: account.id,
    provider: account.provider,
    method,
    checkedAt: new Date(now).toISOString(),
  };
  if (method === 'browser') {
    return {
      ...base,
      status: 'unknown',
      detail:
        'Signed in through its own Chromium profile; checking would mean opening the browser.',
    };
  }
  if (method === 'api-key') {
    if (account.hasSecret === false && account.provider !== 'openai-compatible') {
      return {
        ...base,
        status: 'not_connected',
        detail: 'No API key stored. Add one to connect this account.',
      };
    }
    return { ...base, status: 'connected', detail: 'API key stored in the encrypted keyring.' };
  }
  return {
    ...base,
    loginCommand: `davecode accounts login ${account.id}`,
    ...(loggedIn
      ? { status: 'connected', detail: 'The vendor CLI reports a login for this account.' }
      : { status: 'not_connected', detail: 'No login in this account’s sandbox yet.' }),
  };
}
