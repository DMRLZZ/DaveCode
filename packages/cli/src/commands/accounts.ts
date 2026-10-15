import { createInterface } from 'node:readline';
import {
  type Account,
  type AccountConnection,
  CLI_LOGINS,
  cliBinaryFor,
  globalPaths,
  loginEnv,
  type ProviderKind,
  SandboxManager,
  type SubscriptionInfo,
} from '@davecode/core';
import { type CliContext, printJson } from '../context';
import { CliError, EXIT } from '../errors';
import {
  type AddFlags,
  accountFromFlags,
  accountInteractively,
  accountPolicy,
  describeCreate,
  providerInfo,
} from '../lib/account-flow';
import { type AccountsBackend, openAccounts, resolveAccount } from '../lib/accounts-backend';
import { type SpawnFn, spawnInteractive, which } from '../lib/proc';
import { PromptCancelledError, type Prompter } from '../lib/prompter';
import { detectProjectRoot } from '../runtime';
import { type Column, table, truncate } from '../ui/format';
import type { Theme } from '../ui/theme';

export interface AccountsDeps {
  /** Override the backend (tests). */
  backend?: AccountsBackend;
  prompter?: Prompter;
  readStdin?: () => Promise<string>;
  spawn?: SpawnFn;
  /** Used by `accounts login --hold` (tests). */
  waitForEnter?: () => Promise<void>;
}

export interface BackendFlags {
  /** Write to state.db even if a gateway is running. */
  local?: boolean;
}

async function backendFor(
  ctx: CliContext,
  flags: BackendFlags,
  deps: AccountsDeps,
): Promise<AccountsBackend> {
  if (deps.backend) return deps.backend;
  const projectRoot = await detectProjectRoot(ctx.cwd, ctx.home);
  return openAccounts({
    home: ctx.home,
    env: ctx.env,
    ...(projectRoot ? { projectRoot } : {}),
    ...(flags.local ? { local: true } : {}),
  });
}

async function withBackend<T>(
  ctx: CliContext,
  flags: BackendFlags,
  deps: AccountsDeps,
  fn: (backend: AccountsBackend) => Promise<T>,
): Promise<T> {
  const backend = await backendFor(ctx, flags, deps);
  try {
    return await fn(backend);
  } finally {
    if (!deps.backend) backend.close();
  }
}

async function prompterFor(ctx: CliContext, deps: AccountsDeps): Promise<Prompter> {
  if (deps.prompter) return deps.prompter;
  const { createInkPrompter } = await import('../tui/prompts');
  return createInkPrompter({ stdout: ctx.io.stdout, stdin: ctx.io.stdin, theme: ctx.theme });
}

function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function statusText(theme: Theme, account: Account): string {
  switch (account.status) {
    case 'active':
      return theme.ok('active');
    case 'cooldown':
      return theme.warn('cooldown');
    case 'error':
      return theme.error('error');
    default:
      return theme.dim('disabled');
  }
}

function detail(account: Account): string {
  const config = account.config;
  const parts: string[] = [];
  if (typeof config.baseUrl === 'string') parts.push(config.baseUrl);
  if (Array.isArray(config.models) && config.models.length > 0) {
    parts.push(config.models.slice(0, 3).join(', ') + (config.models.length > 3 ? ', …' : ''));
  }
  if (typeof config.binaryPath === 'string') parts.push(config.binaryPath);
  return parts.join(' · ');
}

export function renderAccountList(theme: Theme, accounts: Account[], columns: number): string[] {
  const cols: Column[] = [
    { header: 'ID' },
    { header: 'LABEL' },
    { header: 'PROVIDER' },
    { header: 'STATUS' },
    { header: 'PRI', align: 'right', drop: 2 },
    { header: 'WEIGHT', align: 'right', drop: 3 },
    { header: 'DETAILS', drop: 4 },
  ];
  const rows = accounts.map((a) => [
    theme.accent(a.id),
    truncate(a.label, 28),
    a.provider,
    statusText(theme, a),
    String(a.priority),
    String(a.weight),
    theme.dim(truncate(detail(a), 40)),
  ]);
  return table(theme, cols, rows, columns);
}

export async function accountsList(
  ctx: CliContext,
  flags: BackendFlags = {},
  deps: AccountsDeps = {},
): Promise<number> {
  return withBackend(ctx, flags, deps, async (backend) => {
    const accounts = await backend.list();
    if (ctx.json) {
      printJson(ctx, { source: backend.kind, accounts });
      return EXIT.ok;
    }
    if (accounts.length === 0) {
      ctx.out(ctx.theme.dim('No accounts yet.'));
      ctx.out(`Add one with ${ctx.theme.accent('davecode accounts add')}.`);
      return EXIT.ok;
    }
    for (const line of renderAccountList(ctx.theme, accounts, ctx.columns)) ctx.out(line);
    ctx.out();
    ctx.out(
      ctx.theme.dim(backend.kind === 'gateway' ? 'source: running gateway' : 'source: local state'),
    );
    return EXIT.ok;
  });
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

export interface AddCommandFlags extends AddFlags, BackendFlags {
  /** Never prompt; everything comes from flags. */
  yes?: boolean;
  /** commander's `--no-login`. */
  login?: boolean;
}

export async function accountsAdd(
  ctx: CliContext,
  flags: AddCommandFlags,
  deps: AccountsDeps = {},
): Promise<number> {
  return withBackend(ctx, flags, deps, async (backend) => {
    const existing = await backend.list();
    const interactive = ctx.interactive && !flags.yes && !flags.secretStdin;
    const { theme, errTheme } = ctx;

    let create: Awaited<ReturnType<typeof accountFromFlags>> | undefined;
    if (interactive) {
      try {
        create = await accountInteractively(flags, {
          prompter: await prompterFor(ctx, deps),
          config: backend.config,
          existing,
          say: (line) => ctx.out(line),
          warn: theme.warn,
        });
      } catch (err) {
        if (err instanceof PromptCancelledError) {
          ctx.err(errTheme.dim('Cancelled.'));
          return EXIT.failure;
        }
        throw err;
      }
      if (!create) {
        ctx.err(errTheme.dim('Nothing added.'));
        return EXIT.failure;
      }
    } else {
      create = await accountFromFlags(flags, {
        env: ctx.env,
        readStdin: deps.readStdin ?? readAllStdin,
      });
      const policy = accountPolicy(create.provider, backend.config, existing);
      if (policy.blocked) {
        throw new CliError(policy.blocked.message, { hint: policy.blocked.hint });
      }
      for (const warning of policy.warnings) {
        ctx.err(errTheme.warn(`${errTheme.glyph.warn} ${warning}`));
      }
      if (flags.secret !== undefined) {
        ctx.err(
          errTheme.dim(
            'Note: --secret is visible in shell history and process lists; prefer --secret-env or --secret-stdin.',
          ),
        );
      }
    }

    const account = await backend.create(create);
    if (ctx.json) {
      printJson(ctx, { account });
      return EXIT.ok;
    }
    ctx.out(
      `${theme.ok(theme.glyph.ok)} Added ${theme.bold(account.label)} ${theme.dim(`(${account.id}, ${account.provider})`)}`,
    );
    if (!interactive) {
      for (const line of describeCreate(create)) ctx.out(theme.dim(`  ${line}`));
    }

    const info = providerInfo(account.provider);
    if (info?.auth === 'cli-login') {
      const loginNow =
        interactive &&
        flags.login !== false &&
        (await (
          await prompterFor(ctx, deps)
        ).confirm(`Log in to ${info.binary} for this account now?`, true));
      if (loginNow) return accountsLogin(ctx, account.id, [], flags, { ...deps, backend });
      ctx.out(
        theme.dim(`Next: log in with ${theme.accent(`davecode accounts login ${account.id}`)}`),
      );
    }
    return EXIT.ok;
  });
}

// ---------------------------------------------------------------------------
// remove / enable / disable
// ---------------------------------------------------------------------------

export async function accountsRemove(
  ctx: CliContext,
  ref: string,
  flags: BackendFlags & { yes?: boolean },
  deps: AccountsDeps = {},
): Promise<number> {
  return withBackend(ctx, flags, deps, async (backend) => {
    const account = await resolveAccount(backend, ref);
    if (!flags.yes) {
      if (!ctx.interactive) {
        throw new CliError(`Refusing to remove ${account.id} without confirmation`, {
          hint: 'Pass --yes to remove it non-interactively.',
        });
      }
      const ok = await (await prompterFor(ctx, deps))
        .confirm(`Remove ${account.label} (${account.id}) and its sandbox?`, false)
        .catch((err: unknown) => {
          if (err instanceof PromptCancelledError) return false;
          throw err;
        });
      if (!ok) {
        ctx.err(ctx.errTheme.dim('Nothing removed.'));
        return EXIT.failure;
      }
    }
    await backend.remove(account.id);
    if (ctx.json) printJson(ctx, { removed: account.id });
    else ctx.out(`${ctx.theme.ok(ctx.theme.glyph.ok)} Removed ${account.label} (${account.id})`);
    return EXIT.ok;
  });
}

export async function accountsSetEnabled(
  ctx: CliContext,
  ref: string,
  enabled: boolean,
  flags: BackendFlags = {},
  deps: AccountsDeps = {},
): Promise<number> {
  return withBackend(ctx, flags, deps, async (backend) => {
    const account = await resolveAccount(backend, ref);
    const updated = await backend.update(account.id, { enabled });
    if (ctx.json) printJson(ctx, { account: updated });
    else {
      ctx.out(
        `${ctx.theme.ok(ctx.theme.glyph.ok)} ${updated.label} is now ${enabled ? 'enabled' : 'disabled'} ${ctx.theme.dim(`(${updated.status})`)}`,
      );
    }
    return EXIT.ok;
  });
}

// ---------------------------------------------------------------------------
// plan (subscription details)
// ---------------------------------------------------------------------------

export interface PlanFlags extends BackendFlags {
  plan?: string;
  paid?: string;
  renews?: string;
  price?: string;
  currency?: string;
  period?: string;
  notes?: string;
  clear?: boolean;
}

export function describeSubscription(subscription: SubscriptionInfo | undefined): string {
  if (!subscription) return 'no plan recorded';
  const parts: string[] = [];
  if (subscription.plan) parts.push(subscription.plan);
  if (subscription.price) {
    const { amount, currency, period } = subscription.price;
    parts.push(`${amount} ${currency}/${period}`);
  }
  if (subscription.paidAt) parts.push(`paid ${subscription.paidAt}`);
  if (subscription.renewsAt) parts.push(`renews ${subscription.renewsAt}`);
  if (subscription.notes) parts.push(subscription.notes);
  return parts.length > 0 ? parts.join(' · ') : 'no plan recorded';
}

/** Merge plan flags into the existing subscription details (validated by the backend). */
export function subscriptionFromFlags(
  existing: SubscriptionInfo | undefined,
  flags: PlanFlags,
): SubscriptionInfo {
  const next: SubscriptionInfo = { ...existing };
  if (flags.plan !== undefined) next.plan = flags.plan;
  if (flags.paid !== undefined) next.paidAt = flags.paid;
  if (flags.renews !== undefined) next.renewsAt = flags.renews;
  if (flags.notes !== undefined) next.notes = flags.notes;
  if (flags.price !== undefined || flags.currency !== undefined || flags.period !== undefined) {
    const amount = flags.price !== undefined ? Number(flags.price) : existing?.price?.amount;
    if (amount === undefined || !Number.isFinite(amount)) {
      throw new CliError('--price needs a number, e.g. --price 20', {
        hint: 'Set the amount with --price, and optionally --currency USD --period month.',
      });
    }
    const period = flags.period ?? existing?.price?.period ?? 'month';
    if (period !== 'month' && period !== 'year') {
      throw new CliError('--period must be "month" or "year"');
    }
    next.price = { amount, currency: flags.currency ?? existing?.price?.currency ?? 'USD', period };
  }
  return next;
}

export async function accountsPlan(
  ctx: CliContext,
  ref: string,
  flags: PlanFlags = {},
  deps: AccountsDeps = {},
): Promise<number> {
  return withBackend(ctx, flags, deps, async (backend) => {
    const account = await resolveAccount(backend, ref);
    const { theme } = ctx;
    const changes = ['plan', 'paid', 'renews', 'price', 'currency', 'period', 'notes'] as const;
    const editing = flags.clear || changes.some((key) => flags[key] !== undefined);
    if (!editing) {
      if (ctx.json)
        printJson(ctx, { account: account.id, subscription: account.subscription ?? null });
      else ctx.out(`${theme.bold(account.label)}: ${describeSubscription(account.subscription)}`);
      return EXIT.ok;
    }
    const subscription = flags.clear ? null : subscriptionFromFlags(account.subscription, flags);
    const updated = await backend.update(account.id, { subscription });
    if (ctx.json) printJson(ctx, { account: updated });
    else {
      ctx.out(
        `${theme.ok(theme.glyph.ok)} ${updated.label}: ${describeSubscription(updated.subscription)}`,
      );
    }
    return EXIT.ok;
  });
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

/** Arguments that start each CLI's own official login flow. */
export function loginArgs(provider: ProviderKind): string[] {
  return CLI_LOGINS[provider]?.loginArgs ?? [];
}

export interface LoginFlags extends BackendFlags {
  /** Wait for Enter before exiting (used when the dashboard opened this in a new window). */
  hold?: boolean;
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Press Enter to close this window.', () => {
      rl.close();
      resolve();
    });
    rl.once('close', resolve);
  });
}

export function describeConnection(theme: Theme, connection: AccountConnection): string {
  const label: Record<AccountConnection['status'], string> = {
    connected: theme.ok(`${theme.glyph.ok} connected`),
    not_connected: theme.warn(`${theme.glyph.warn} not connected`),
    unknown: theme.dim('? unknown'),
  };
  return `${label[connection.status]}${connection.detail ? theme.dim(` — ${connection.detail}`) : ''}`;
}

export async function accountsLogin(
  ctx: CliContext,
  ref: string,
  extraArgs: string[] = [],
  flags: LoginFlags = {},
  deps: AccountsDeps = {},
): Promise<number> {
  if (!flags.hold) return runLogin(ctx, ref, extraArgs, flags, deps);
  try {
    return await runLogin(ctx, ref, extraArgs, flags, deps);
  } catch (err) {
    ctx.err(ctx.errTheme.warn(err instanceof Error ? err.message : String(err)));
    return EXIT.failure;
  } finally {
    await (deps.waitForEnter ?? waitForEnter)();
  }
}

function runLogin(
  ctx: CliContext,
  ref: string,
  extraArgs: string[],
  flags: LoginFlags,
  deps: AccountsDeps,
): Promise<number> {
  return withBackend(ctx, flags, deps, async (backend) => {
    const account = await resolveAccount(backend, ref);
    const spec = CLI_LOGINS[account.provider];
    if (!spec) {
      const info = providerInfo(account.provider);
      throw new CliError(`${account.provider} accounts do not use a CLI login`, {
        hint:
          info?.auth === 'api-key' || info?.auth === 'optional-key'
            ? `Rotate the key with: davecode accounts add … or PATCH /api/accounts/${account.id}`
            : undefined,
      });
    }
    const binary = cliBinaryFor(account) ?? spec.binary;
    const resolved = which(binary, ctx.env);
    if (!resolved) {
      throw new CliError(`Cannot find \`${binary}\` on PATH`, { hint: spec.installHint });
    }

    const sandboxes = new SandboxManager(globalPaths(ctx.home).sandboxes);
    const dir = sandboxes.prepare(account);
    const isolation = loginEnv(account, sandboxes);
    const env = { ...ctx.env, ...isolation };
    const [variable] = Object.keys(isolation);
    const { theme } = ctx;

    ctx.out(
      `${theme.accent(theme.glyph.arrow)} Logging in ${theme.bold(account.label)} ${theme.dim(`(${account.id})`)}`,
    );
    ctx.out(theme.dim(`  ${variable}=${dir}`));
    ctx.out(theme.dim(`  ${spec.instructions}`));
    ctx.out(theme.dim('  DaveCode never sees your password; the vendor CLI keeps the login.'));
    ctx.out();

    const args = extraArgs.length > 0 ? extraArgs : spec.loginArgs;
    const exit = await spawnInteractive(resolved, args, {
      env,
      cwd: dir,
      ...(deps.spawn ? { spawn: deps.spawn } : {}),
    });
    ctx.out();
    if (exit !== 0) {
      ctx.err(ctx.errTheme.warn(`${binary} exited with code ${exit}`));
      return exit;
    }
    if (account.status === 'error' && account.enabled) {
      // A fresh login fixes auth errors; reset the account so the router tries it again.
      await backend.update(account.id, { enabled: true });
    }
    const connection = await backend.connection(account.id).catch(() => undefined);
    if (connection) ctx.out(`  ${describeConnection(theme, connection)}`);
    ctx.out(
      `${theme.ok(theme.glyph.ok)} ${account.label} is ready. Its login lives only in ${dir}`,
    );
    return EXIT.ok;
  });
}

export interface ConnectFlags extends BackendFlags {
  /** Only report the connection state. */
  check?: boolean;
}

/**
 * "Connect subscription" from the terminal: show the account's connection state and, for
 * CLI-login accounts that are not connected, run the vendor's official login.
 */
export async function accountsConnect(
  ctx: CliContext,
  ref: string,
  flags: ConnectFlags = {},
  deps: AccountsDeps = {},
): Promise<number> {
  const { account, connection } = await withBackend(ctx, flags, deps, async (backend) => {
    const account = await resolveAccount(backend, ref);
    return { account, connection: await backend.connection(account.id) };
  });
  if (ctx.json) {
    printJson(ctx, { connection });
    return connection.status === 'connected' || flags.check ? EXIT.ok : EXIT.failure;
  }
  const { theme } = ctx;
  ctx.out(`${theme.bold(account.label)} ${theme.dim(`(${account.id}, ${account.provider})`)}`);
  ctx.out(`  ${describeConnection(theme, connection)}`);
  if (flags.check || connection.status === 'connected') return EXIT.ok;
  if (connection.method === 'api-key') {
    ctx.out(
      theme.dim(
        `  Store a key in the dashboard (Accounts → ${account.label}) or re-add the account with --secret-env.`,
      ),
    );
    return EXIT.failure;
  }
  if (connection.method !== 'cli-login') return EXIT.failure;
  ctx.out();
  return accountsLogin(ctx, account.id, [], flags, deps);
}
