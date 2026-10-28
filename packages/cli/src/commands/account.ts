import {
  AccountClient,
  type AccountServiceConfig,
  type AccountSession,
  AccountStore,
  accountService,
  startAccountLogin,
} from '@davecode/core';
import type { CliContext } from '../context';
import { CliError, EXIT } from '../errors';
import { openBrowser } from '../lib/browser';

export interface AccountDeps {
  service?: AccountServiceConfig;
  fetch?: typeof fetch;
  open?: (url: string) => Promise<boolean>;
}

function serviceFor(ctx: CliContext, deps: AccountDeps): AccountServiceConfig | undefined {
  return deps.service ?? accountService(ctx.env);
}

function clientFor(service: AccountServiceConfig, deps: AccountDeps): AccountClient {
  return new AccountClient(service, deps.fetch ? { fetch: deps.fetch } : {});
}

export function describeUser(session: AccountSession): string {
  return session.user.email ?? session.user.name ?? session.user.id;
}

/** The signed-in session (refreshed when needed), or undefined. */
export async function currentAccount(
  ctx: CliContext,
  deps: AccountDeps = {},
): Promise<AccountSession | undefined> {
  const service = serviceFor(ctx, deps);
  if (!service) return undefined;
  return new AccountStore(ctx.home, ctx.env).current(clientFor(service, deps));
}

/** Whether this build signs in to DaveCode accounts at all (it needs a configured service). */
export function accountsEnabled(ctx: CliContext, deps: AccountDeps = {}): boolean {
  return serviceFor(ctx, deps) !== undefined;
}

/**
 * Open the browser sign-in page and wait for it to finish. Prints the URL too, for machines
 * where no browser can be launched (SSH, containers).
 */
export async function signIn(
  ctx: CliContext,
  deps: AccountDeps = {},
  announce?: (url: string, opened: boolean) => void,
): Promise<AccountSession> {
  const service = serviceFor(ctx, deps);
  if (!service) {
    throw new CliError('DaveCode accounts are not available in this build');
  }
  const { theme } = ctx;
  const login = await startAccountLogin({ client: clientFor(service, deps) });
  const opened = await (deps.open ?? openBrowser)(login.url).catch(() => false);
  if (announce) announce(login.url, opened);
  else {
    ctx.out(
      opened
        ? `${theme.accent(theme.glyph.arrow)} Opened your browser to sign in.`
        : `${theme.accent(theme.glyph.arrow)} Open this link to sign in:`,
    );
    ctx.out(theme.dim(`  ${login.url}`));
    ctx.out(theme.dim('  Waiting for you to finish in the browser. Ctrl+C cancels.'));
  }
  const cancel = () => void login.close();
  process.once('SIGINT', cancel);
  try {
    const session = await login.session;
    new AccountStore(ctx.home, ctx.env).save(session);
    return session;
  } finally {
    process.off('SIGINT', cancel);
  }
}

export async function loginCommand(ctx: CliContext, deps: AccountDeps = {}): Promise<number> {
  const session = await signIn(ctx, deps);
  ctx.out(
    `${ctx.theme.ok(ctx.theme.glyph.ok)} Signed in as ${ctx.theme.bold(describeUser(session))}`,
  );
  return EXIT.ok;
}

export async function logoutCommand(ctx: CliContext, deps: AccountDeps = {}): Promise<number> {
  const store = new AccountStore(ctx.home, ctx.env);
  const session = store.load();
  const service = serviceFor(ctx, deps);
  if (session && service) await clientFor(service, deps).signOut(session.accessToken);
  store.clear();
  ctx.out(session ? 'Signed out.' : 'You were not signed in.');
  return EXIT.ok;
}

export async function accountCommand(ctx: CliContext, deps: AccountDeps = {}): Promise<number> {
  const session = await currentAccount(ctx, deps);
  if (ctx.json) {
    ctx.out(JSON.stringify({ signedIn: Boolean(session), user: session?.user ?? null }));
    return session ? EXIT.ok : EXIT.failure;
  }
  if (!session) {
    ctx.out(`Not signed in. Run ${ctx.theme.accent('davecode login')}.`);
    return EXIT.failure;
  }
  const via = session.user.provider ? ctx.theme.dim(` (${session.user.provider})`) : '';
  ctx.out(`Signed in as ${ctx.theme.bold(describeUser(session))}${via}`);
  return EXIT.ok;
}

/** Account actions for the chat's /login, /logout and /account (they return text, never print). */
export interface ChatAccountActions {
  status(): Promise<string>;
  login(notify: (text: string) => void): Promise<string>;
  logout(): Promise<string>;
}

export function chatAccountActions(
  ctx: CliContext,
  deps: AccountDeps = {},
): ChatAccountActions | undefined {
  if (!accountsEnabled(ctx, deps)) return undefined;
  return {
    status: async () => {
      const session = await currentAccount(ctx, deps);
      return session ? `Signed in as ${describeUser(session)}` : 'Not signed in. Type /login.';
    },
    login: async (notify) => {
      const session = await signIn(ctx, deps, (url, opened) =>
        notify(
          `${opened ? 'Opened your browser to sign in.' : 'Open this link to sign in:'}\n${url}`,
        ),
      );
      return `Signed in as ${describeUser(session)}`;
    },
    logout: async () => {
      const store = new AccountStore(ctx.home, ctx.env);
      const session = store.load();
      const service = serviceFor(ctx, deps);
      if (session && service) await clientFor(service, deps).signOut(session.accessToken);
      store.clear();
      return session ? 'Signed out. Type /login to sign in again.' : 'You were not signed in.';
    },
  };
}
