import { z } from 'zod';
import type { AccountLoginStart, AccountState, LoginProvider } from './types';

const accountStateSchema = z.object({
  signedIn: z.boolean(),
  user: z
    .object({
      id: z.string(),
      email: z.string().optional(),
      name: z.string().optional(),
      provider: z.string().optional(),
    })
    .nullable(),
  pending: z.boolean(),
  error: z.string().nullable(),
});

const loginStartSchema = z.object({ url: z.string().url(), opened: z.boolean() });

function headers(token: string, json = false): Record<string, string> {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

/**
 * The machine's DaveCode account, or null when this gateway cannot offer one (remote gateway,
 * older version, missing token). Local mode still works in that case.
 */
export async function fetchAccount(base: string, token: string): Promise<AccountState | null> {
  const response = await fetch(`${base}/api/account`, {
    headers: headers(token),
    cache: 'no-store',
  });
  if (!response.ok) return null;
  const parsed = accountStateSchema.safeParse(await response.json());
  return parsed.success ? parsed.data : null;
}

export async function startAccountSignIn(
  base: string,
  token: string,
  provider?: LoginProvider,
): Promise<AccountLoginStart> {
  const response = await fetch(`${base}/api/account/login`, {
    method: 'POST',
    headers: headers(token, true),
    body: JSON.stringify(provider ? { provider } : {}),
  });
  if (!response.ok) throw new Error('Could not start the sign-in.');
  return loginStartSchema.parse(await response.json());
}

async function post(base: string, token: string, path: string): Promise<void> {
  const response = await fetch(`${base}/api/account/${path}`, {
    method: 'POST',
    headers: headers(token, true),
  });
  if (!response.ok) throw new Error(`Account request failed: ${path}`);
}

export const cancelAccountSignIn = (base: string, token: string) => post(base, token, 'cancel');
export const signOutAccount = (base: string, token: string) => post(base, token, 'logout');

/** The name to show for a signed-in account. */
export function accountName(user: AccountState['user']): string {
  return user?.name ?? user?.email ?? 'your DaveCode account';
}
