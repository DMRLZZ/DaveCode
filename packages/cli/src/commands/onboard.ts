import { execFile } from 'node:child_process';
import {
  CLI_LOGINS,
  loadConfig,
  type ProviderKind,
  type Route,
  VERSION,
  writeGlobalRouting,
} from '@davecode/core';
import type { CliContext } from '../context';
import { type AccountsBackend, openAccounts } from '../lib/accounts-backend';
import { readPreferences, writePreferences } from '../lib/preferences';
import { which as whichOnPath } from '../lib/proc';
import { PromptCancelledError, type Prompter } from '../lib/prompter';
import { brandBanner } from '../ui/banner';
import { createTheme, type ThemeMode } from '../ui/theme';
import { type AccountDeps, accountsEnabled, currentAccount, describeUser, signIn } from './account';
import { accountsLogin } from './accounts';

/** Agents DaveCode can drive today, in the order they are offered. */
export const AGENTS: ReadonlyArray<{
  provider: ProviderKind;
  name: string;
  models: Array<{ value: string; label: string; hint?: string }>;
}> = [
  {
    provider: 'claude-cli',
    name: 'Claude Code',
    models: [
      { value: 'default', label: 'Default', hint: 'Claude Code decides' },
      { value: 'opus', label: 'Opus', hint: 'most capable' },
      { value: 'sonnet', label: 'Sonnet', hint: 'balanced' },
      { value: 'haiku', label: 'Haiku', hint: 'fastest' },
    ],
  },
  {
    provider: 'codex-cli',
    name: 'Codex',
    models: [{ value: 'default', label: 'Default', hint: 'Codex decides' }],
  },
  {
    provider: 'antigravity-cli',
    name: 'Antigravity',
    models: [{ value: 'default', label: 'Default', hint: 'Antigravity decides' }],
  },
];

type ModelChoice = { value: string; label: string; hint?: string };

/** Antigravity lists its models with `agy models` as `id<TAB>name` lines. */
export function parseAgyModels(stdout: string): ModelChoice[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .filter(([id, name]) => id && name && /^[\w.:-]+$/.test(id.trim()))
    .map(([id, name]) => ({ value: (id as string).trim(), label: (name as string).trim() }));
}

function agyModels(binary: string, env: NodeJS.ProcessEnv): Promise<ModelChoice[]> {
  return new Promise((resolve) => {
    execFile(binary, ['models'], { env, timeout: 30_000, windowsHide: true }, (error, stdout) =>
      resolve(error ? [] : parseAgyModels(String(stdout))),
    );
  });
}

const OTHER_MODEL = '__other__';

export interface OnboardDeps extends AccountDeps {
  prompter?: Prompter;
  backend?: AccountsBackend;
  which?: (binary: string) => string | undefined;
  /** Models an agent offers beyond its built-in list (defaults to asking `agy models`). */
  models?: (provider: ProviderKind) => Promise<ModelChoice[]>;
  /** Runs the vendor's official login for an account (defaults to `accounts login`). */
  vendorLogin?: (ctx: CliContext, accountId: string) => Promise<number>;
}

async function prompterFor(ctx: CliContext, deps: OnboardDeps): Promise<Prompter> {
  if (deps.prompter) return deps.prompter;
  const { createInkPrompter } = await import('../tui/prompts');
  return createInkPrompter({ stdout: ctx.io.stdout, stdin: ctx.io.stdin, theme: ctx.theme });
}

function welcome(ctx: CliContext): void {
  const { theme } = ctx;
  ctx.out();
  const text = [
    `${theme.bold('Welcome to DaveCode')} ${theme.dim(`v${VERSION}`)}`,
    theme.dim('Run Claude Code, Codex and Antigravity side by side.'),
  ];
  for (const line of brandBanner(theme, text, ctx.columns)) ctx.out(` ${line}`);
  ctx.out();
}

function withTheme(ctx: CliContext, mode: ThemeMode): CliContext {
  return {
    ...ctx,
    theme: createTheme({ color: ctx.theme.color, unicode: ctx.theme.unicode, mode }),
    errTheme: createTheme({ color: ctx.errTheme.color, unicode: ctx.errTheme.unicode, mode }),
  };
}

async function chooseTheme(ctx: CliContext, prompter: Prompter): Promise<ThemeMode> {
  return prompter.select<ThemeMode>(
    'Choose a look for the terminal',
    [
      { value: 'dark', label: 'Dark', hint: 'white text on black' },
      { value: 'light', label: 'Light', hint: 'black text on white' },
      { value: 'auto', label: 'Match my terminal' },
    ],
    readPreferences(ctx.home).theme ?? 'dark',
  );
}

async function signInStep(ctx: CliContext, prompter: Prompter, deps: OnboardDeps): Promise<void> {
  const choice = await prompter.select('Sign in to continue', [
    { value: 'browser', label: 'Sign in with your browser', hint: 'Google, GitHub or email' },
    { value: 'quit', label: 'Quit' },
  ]);
  if (choice === 'quit') throw new PromptCancelledError();
  const session = await signIn(ctx, deps);
  ctx.out(
    `${ctx.theme.ok(ctx.theme.glyph.ok)} Signed in as ${ctx.theme.bold(describeUser(session))}`,
  );
  ctx.out();
}

async function setDefaultRoute(ctx: CliContext, route: Route): Promise<void> {
  const global = loadConfig({ home: ctx.home, env: ctx.env });
  await writeGlobalRouting(ctx.home, {
    routes: [...global.routing.routes.filter((r) => r.name !== route.name), route],
    defaultRoute: route.name,
  });
}

/** First agent: pick one that is installed, log in with its official CLI, choose a model. */
async function connectAgentStep(
  ctx: CliContext,
  prompter: Prompter,
  backend: AccountsBackend,
  deps: OnboardDeps,
): Promise<void> {
  const { theme } = ctx;
  const which = deps.which ?? ((binary: string) => whichOnPath(binary, ctx.env));
  for (;;) {
    const choice = await prompter.select('Connect your first agent', [
      ...AGENTS.map((agent) => {
        const binary = CLI_LOGINS[agent.provider]?.binary ?? '';
        return {
          value: agent.provider as string,
          label: agent.name,
          hint: which(binary) ? 'installed' : 'not installed',
        };
      }),
      { value: 'later', label: 'Later', hint: 'davecode accounts add' },
    ]);
    if (choice === 'later') return;
    const agent = AGENTS.find((a) => a.provider === choice)!;
    const spec = CLI_LOGINS[agent.provider]!;
    if (!which(spec.binary)) {
      ctx.out(theme.warn(` ${agent.name} is not installed.`));
      ctx.out(theme.dim(` ${spec.installHint}`));
      ctx.out();
      continue;
    }

    const account = await backend.create({ provider: agent.provider, label: agent.name });
    const connection = await backend.connection(account.id).catch(() => undefined);
    if (connection?.status !== 'connected') {
      const exit = await (
        deps.vendorLogin ?? ((c, id) => accountsLogin(c, id, [], {}, { backend }))
      )(ctx, account.id);
      if (exit !== 0) {
        ctx.out(theme.warn(` ${agent.name} did not finish signing in. You can retry later with:`));
        ctx.out(theme.dim(`   davecode accounts login ${account.id}`));
      }
    } else {
      ctx.out(`${theme.ok(theme.glyph.ok)} ${agent.name} is already signed in.`);
    }

    const discovered =
      agent.provider === 'antigravity-cli'
        ? await (deps.models ?? (() => agyModels(which(spec.binary) ?? spec.binary, ctx.env)))(
            agent.provider,
          )
        : [];
    let model = await prompter.select(`Model for ${agent.name}`, [
      ...agent.models,
      ...discovered,
      { value: OTHER_MODEL, label: 'Another model…', hint: 'type its id' },
    ]);
    if (model === OTHER_MODEL) {
      model = await prompter.text('Model id', {
        validate: (v) =>
          /^[\w.:[\]-]+$/.test(v.trim()) ? undefined : 'Use letters, digits, . : - _',
      });
      model = model.trim();
    }
    await setDefaultRoute(ctx, {
      name: 'auto',
      description: `${agent.name} (${model})`,
      targets: [{ provider: agent.provider, model, accountId: account.id }],
    });
    ctx.out(`${theme.ok(theme.glyph.ok)} DaveCode will use ${theme.bold(agent.name)} · ${model}`);
    ctx.out();
    return;
  }
}

/**
 * First-run setup, Claude Code style: logo, look, DaveCode account, first agent. Later runs
 * only ask to sign in again when the session is gone. Returns the context to continue with
 * (the chosen theme applied), or undefined when the user quits.
 */
export async function ensureReady(
  ctx: CliContext,
  deps: OnboardDeps = {},
): Promise<CliContext | undefined> {
  const prefs = readPreferences(ctx.home);
  const needsAccount = accountsEnabled(ctx, deps) && !(await currentAccount(ctx, deps));
  if (prefs.onboarded && !needsAccount) return ctx;

  let current = ctx;
  const prompter = await prompterFor(ctx, deps);
  try {
    if (!prefs.onboarded) {
      welcome(ctx);
      const mode = await chooseTheme(ctx, prompter);
      writePreferences(ctx.home, { theme: mode });
      current = withTheme(ctx, mode);
    }
    if (needsAccount) await signInStep(current, prompter, deps);
    if (!prefs.onboarded) {
      const backend =
        deps.backend ?? (await openAccounts({ home: current.home, env: current.env, local: true }));
      try {
        const existing = await backend.list();
        if (existing.length === 0) await connectAgentStep(current, prompter, backend, deps);
      } finally {
        if (!deps.backend) backend.close();
      }
      writePreferences(current.home, { onboarded: true });
    }
    return current;
  } catch (err) {
    if (err instanceof PromptCancelledError) {
      ctx.err(ctx.errTheme.dim('Setup cancelled. Run davecode again to continue.'));
      return undefined;
    }
    throw err;
  }
}
