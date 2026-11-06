import {
  AccountClient,
  type AccountServiceConfig,
  type AccountUser,
  accountService,
  type OAuthProvider,
} from './client';
import { type AccountLogin, startAccountLogin } from './login-server';
import { AccountStore } from './store';

/** What a local app may know about the signed-in account: identity only, never tokens. */
export interface AccountState {
  signedIn: boolean;
  user: AccountUser | null;
  /** A browser sign-in is waiting to finish. */
  pending: boolean;
  /** Why the last sign-in did not finish, safe to show. */
  error: string | null;
}

export interface AccountLoginStart {
  /** Show this link when the browser could not be opened. */
  url: string;
  opened: boolean;
}

/** The machine's DaveCode account, shared with `davecode login` through the same store. */
export interface AccountControl {
  state(): Promise<AccountState>;
  /** Opens the browser and returns without waiting; a new sign-in replaces a pending one. */
  login(provider?: OAuthProvider): Promise<AccountLoginStart>;
  cancel(): Promise<void>;
  logout(): Promise<void>;
  /** Stops listening for a pending sign-in. */
  close(): Promise<void>;
}

export interface AccountControlOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  /** Opens a URL in the user's browser. Resolves false when it could not. */
  open(url: string): Promise<boolean>;
  service?: AccountServiceConfig;
  fetch?: typeof fetch;
  /** Give up on a sign-in after this long (default 10 minutes). */
  timeoutMs?: number;
}

const SIGN_IN_FAILED = 'Sign-in did not finish. Please try again.';

/** Undefined when this build has no account service. */
export function createAccountControl(options: AccountControlOptions): AccountControl | undefined {
  const service = options.service ?? accountService(options.env);
  if (!service) return undefined;
  const client = new AccountClient(service, options.fetch ? { fetch: options.fetch } : {});
  // Built on use: reading the master key must not be able to stop a gateway from starting.
  const store = () => new AccountStore(options.home, options.env);
  let active: AccountLogin | undefined;
  let error: string | null = null;

  async function stop(): Promise<void> {
    const login = active;
    active = undefined;
    await login?.close();
  }

  async function finish(login: AccountLogin): Promise<void> {
    try {
      const session = await login.session;
      if (active !== login) return;
      active = undefined;
      store().save(session);
    } catch {
      // A replaced or cancelled sign-in is not a failure the user needs to hear about.
      if (active !== login) return;
      active = undefined;
      error = SIGN_IN_FAILED;
    }
  }

  return {
    async state() {
      const session = await store().current(client);
      return {
        signedIn: Boolean(session),
        user: session?.user ?? null,
        pending: active !== undefined,
        error,
      };
    },
    async login(provider) {
      await stop();
      error = null;
      const login = await startAccountLogin({
        client,
        ...(provider ? { provider } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      active = login;
      void finish(login);
      const opened = await options.open(login.url).catch(() => false);
      return { url: login.url, opened };
    },
    async cancel() {
      error = null;
      await stop();
    },
    async logout() {
      await stop();
      error = null;
      const accounts = store();
      const session = accounts.load();
      try {
        if (session) await client.signOut(session.accessToken);
      } catch {
        // Offline or rejected: this machine still signs out, and the token expires by itself.
      }
      accounts.clear();
    },
    close: stop,
  };
}
