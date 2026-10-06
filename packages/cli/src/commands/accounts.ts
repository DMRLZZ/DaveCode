import { type Account, globalPaths, SandboxManager } from '@davecode/core';
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
// login
// ---------------------------------------------------------------------------

const INSTALL_HINTS: Record<string, string> = {
  'claude-cli': 'Install Claude Code: npm install -g @anthropic-ai/claude-code',
  'codex-cli': 'Install Codex: npm install -g @openai/codex',
};

/** Arguments that start each CLI's own login flow. */
export function loginArgs(provider: string): string[] {
  return provider === 'codex-cli' ? ['login'] : [];
}

export async function accountsLogin(
  ctx: CliContext,
  ref: string,
  extraArgs: string[] = [],
  flags: BackendFlags = {},
  deps: AccountsDeps = {},
): Promise<number> {
  return withBackend(ctx, flags, deps, async (backend) => {
    const account = await resolveAccount(backend, ref);
    const info = providerInfo(account.provider);
    if (info?.auth !== 'cli-login' || !info.binary) {
      throw new CliError(`${account.provider} accounts do not use a CLI login`, {
        hint:
          info?.auth === 'api-key' || info?.auth === 'optional-key'
            ? `Rotate the key with: davecode accounts add … or PATCH /api/accounts/${account.id}`
            : undefined,
      });
    }
    const binary =
      typeof account.config.binaryPath === 'string' && account.config.binaryPath.trim()
        ? account.config.binaryPath.trim()
        : info.binary;
    const resolved = which(binary, ctx.env);
    if (!resolved) {
      throw new CliError(`Cannot find \`${binary}\` on PATH`, {
        hint: INSTALL_HINTS[account.provider],
      });
    }

    const sandboxes = new SandboxManager(globalPaths(ctx.home).sandboxes);
    const dir = sandboxes.ensure(account.id);
    const isolation = sandboxes.envFor(account);
    const env = { ...ctx.env, ...isolation };
    const [variable] = Object.keys(isolation);
    const { theme } = ctx;

    ctx.out(
      `${theme.accent(theme.glyph.arrow)} Logging in ${theme.bold(account.label)} ${theme.dim(`(${account.id})`)}`,
    );
    ctx.out(theme.dim(`  ${variable}=${dir}`));
    ctx.out(
      theme.dim(
        account.provider === 'claude-cli'
          ? '  Claude Code asks you to sign in on first start (or type /login). Exit with /exit when done.'
          : '  Follow the Codex sign-in flow; it exits when you are logged in.',
      ),
    );
    ctx.out();

    const args = extraArgs.length > 0 ? extraArgs : loginArgs(account.provider);
    const code = await spawnInteractive(resolved, args, {
      env,
      cwd: dir,
      ...(deps.spawn ? { spawn: deps.spawn } : {}),
    });
    ctx.out();
    if (code !== 0) {
      ctx.err(ctx.errTheme.warn(`${binary} exited with code ${code}`));
      return code;
    }
    if (account.status === 'error' && account.enabled) {
      // A fresh login fixes auth errors; reset the account so the router tries it again.
      await backend.update(account.id, { enabled: true });
    }
    ctx.out(
      `${theme.ok(theme.glyph.ok)} ${account.label} is ready. Its login lives only in ${dir}`,
    );
    return EXIT.ok;
  });
}
