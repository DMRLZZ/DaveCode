import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { geminiCliEnv } from '../providers/gemini-cli';
import { isShellSafeArg, needsShell, resolveOnPath } from '../providers/shared/cli';
import type {
  Account,
  AccountConnection,
  ConnectionMethod,
  ConnectionStatus,
  ProviderKind,
} from '../types';
import type { SandboxManager } from './sandbox';

/** A vendor CLI's own login and status commands. DaveCode never sees the credentials. */
export interface CliLoginSpec {
  /** Default binary (overridable per account with `config.binaryPath`). */
  binary: string;
  /** Arguments that start the vendor's official sign-in flow. */
  loginArgs: string[];
  /** Arguments of a non-interactive status command, when the CLI has one. */
  statusArgs?: string[];
  installHint: string;
  /** What the user will see while logging in. */
  instructions: string;
}

export const CLI_LOGINS: Partial<Record<ProviderKind, CliLoginSpec>> = {
  'claude-cli': {
    binary: 'claude',
    loginArgs: ['auth', 'login'],
    statusArgs: ['auth', 'status', '--json'],
    installHint: 'Install Claude Code: npm install -g @anthropic-ai/claude-code',
    instructions: 'Claude Code opens Anthropic’s sign-in page and exits once you are logged in.',
  },
  'codex-cli': {
    binary: 'codex',
    loginArgs: ['login'],
    statusArgs: ['login', 'status'],
    installHint: 'Install Codex: npm install -g @openai/codex',
    instructions: 'Codex opens the ChatGPT sign-in page and exits once you are logged in.',
  },
  'antigravity-cli': {
    binary: 'agy',
    loginArgs: [],
    statusArgs: ['models'],
    installHint: 'Install Antigravity: https://antigravity.google/docs/cli/install',
    instructions:
      'Antigravity opens Google sign-in the first time it starts. Once its prompt appears, type /quit.',
  },
  'gemini-cli': {
    binary: 'gemini',
    loginArgs: [],
    installHint: 'Install Gemini CLI: npm install -g @google/gemini-cli',
    instructions:
      'Gemini CLI starts “Login with Google” in your browser. Once its prompt appears, type /quit.',
  },
};

export function connectionMethod(provider: ProviderKind): ConnectionMethod {
  if (CLI_LOGINS[provider]) return 'cli-login';
  if (provider === 'gemini-web') return 'browser';
  return 'api-key';
}

/** DaveCode command that runs the official login for `accountId` inside its sandbox. */
export function loginCommandFor(accountId: string): string {
  return `davecode accounts login ${accountId}`;
}

/** Environment that points the vendor CLI at the account's sandbox. */
export function loginEnv(
  account: Pick<Account, 'id' | 'provider'>,
  sandboxes: SandboxManager,
): Record<string, string> {
  if (account.provider === 'gemini-cli') return geminiCliEnv(sandboxes.dirFor(account.id));
  return sandboxes.envFor(account);
}

/** The binary to run for an account: `config.binaryPath` or the vendor default. */
export function cliBinaryFor(account: Pick<Account, 'provider' | 'config'>): string | undefined {
  const configured = account.config.binaryPath;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  return CLI_LOGINS[account.provider]?.binary;
}

export interface ProbeCommand {
  command: string;
  args: string[];
  /** Complete environment of the child (also used to resolve `command` on PATH). */
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs: number;
}

export interface ProbeResult {
  /** `null` when the process could not be started or timed out. */
  code: number | null;
  stdout: string;
  /** Set when the binary was not found. */
  missing?: boolean;
  timedOut?: boolean;
}

/** Runs a status command. Injectable so tests never spawn real vendor CLIs. */
export type StatusProbe = (cmd: ProbeCommand) => Promise<ProbeResult>;

const MAX_OUTPUT = 64 * 1024;

export const spawnProbe: StatusProbe = (cmd) =>
  new Promise((resolve) => {
    const resolved = resolveOnPath(cmd.command, cmd.env);
    const shell = needsShell(resolved);
    if (shell && (cmd.args.some((a) => !isShellSafeArg(a)) || /["%!]/.test(resolved))) {
      resolve({ code: null, stdout: '' });
      return;
    }
    const options = {
      cwd: cmd.cwd,
      env: cmd.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
    };
    const child = shell
      ? spawn(`"${resolved}" ${cmd.args.join(' ')}`, { ...options, shell: true })
      : spawn(resolved, cmd.args, options);
    let stdout = '';
    let timedOut = false;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += d;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, cmd.timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve({
        code: null,
        stdout: '',
        missing: (err as NodeJS.ErrnoException).code === 'ENOENT',
      });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(timedOut ? { code: null, stdout: '', timedOut } : { code, stdout });
    });
  });

export interface ConnectionCheckerOptions {
  sandboxes: SandboxManager;
  probe?: StatusProbe;
  clock?: () => number;
  /** Per status command (default 20 s). */
  timeoutMs?: number;
  /** Defaults to `process.platform`; Claude Code keeps macOS logins in the keychain. */
  platform?: NodeJS.Platform;
  /** Base environment of status commands (default `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Reports whether an account can authenticate, without reading or returning credentials:
 * API-key accounts check the keyring flag, CLI accounts ask the vendor CLI's own status
 * command (Claude Code, Codex) or look for the credential file the CLI writes (Gemini CLI).
 */
export class ConnectionChecker {
  private readonly sandboxes: SandboxManager;
  private readonly probe: StatusProbe;
  private readonly clock: () => number;
  private readonly timeoutMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: ConnectionCheckerOptions) {
    this.sandboxes = options.sandboxes;
    this.probe = options.probe ?? spawnProbe;
    this.clock = options.clock ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
  }

  async check(account: Account): Promise<AccountConnection> {
    const method = connectionMethod(account.provider);
    const base = {
      accountId: account.id,
      provider: account.provider,
      method,
      checkedAt: new Date(this.clock()).toISOString(),
    };
    const result = (status: ConnectionStatus, detail?: string): AccountConnection => ({
      ...base,
      status,
      ...(detail ? { detail } : {}),
      ...(method === 'cli-login' ? { loginCommand: loginCommandFor(account.id) } : {}),
    });

    if (method === 'api-key') {
      if (account.hasSecret) return result('connected', 'API key stored in the encrypted keyring.');
      if (account.provider === 'openai-compatible') {
        return result('connected', 'No key stored; fine for local servers that need none.');
      }
      return result('not_connected', 'No API key stored. Add one to connect this account.');
    }
    if (method === 'browser') {
      return result(
        'unknown',
        'Signed in through its own Chromium profile; checking would mean opening the browser.',
      );
    }

    const spec = CLI_LOGINS[account.provider];
    const binary = cliBinaryFor(account);
    if (!spec || !binary) return result('unknown');
    const dir = this.sandboxes.dirFor(account.id);

    if (account.provider === 'gemini-cli') {
      return existsSync(join(dir, '.gemini', 'oauth_creds.json'))
        ? result(
            'connected',
            'Gemini CLI has cached Google credentials in this account’s sandbox (not validated online).',
          )
        : result('not_connected', 'No Google login in this account’s sandbox yet.');
    }

    const statusArgs = spec.statusArgs ?? [];
    const prefix = Array.isArray(account.config.binaryArgs)
      ? account.config.binaryArgs.filter((a): a is string => typeof a === 'string')
      : [];
    const probed = await this.probe({
      command: binary,
      args: [...prefix, ...statusArgs],
      env: { ...this.env, ...loginEnv(account, this.sandboxes) },
      cwd: this.sandboxes.ensure(account.id),
      timeoutMs: this.timeoutMs,
    });
    if (probed.missing)
      return result('unknown', `\`${binary}\` was not found. ${spec.installHint}`);
    if (probed.timedOut || probed.code === null) {
      return result('unknown', `\`${binary}\` did not report its login status.`);
    }

    if (account.provider === 'claude-cli') {
      const loggedIn = claudeLoggedIn(probed.stdout);
      if (loggedIn === undefined) {
        return result('unknown', 'Could not read Claude Code’s login status.');
      }
      if (!loggedIn)
        return result('not_connected', 'Claude Code is not logged in for this account.');
      // Elsewhere the login is a file in the sandbox. Without it Claude Code is reporting a login
      // from outside (the global one or an environment token), which requests here do not use.
      const isolated = this.platform === 'darwin' || existsSync(join(dir, '.credentials.json'));
      return isolated
        ? result('connected', 'Claude Code reports a login for this account.')
        : result(
            'not_connected',
            'Claude Code is signed in globally, but not for this account: sign in once for DaveCode.',
          );
    }

    if (account.provider === 'antigravity-cli') {
      // `agy models` needs a signed-in Google account; it fails without one.
      return probed.code === 0
        ? result(
            'connected',
            'Antigravity is signed in. Its login is shared by every Antigravity account on this machine.',
          )
        : result('not_connected', 'Antigravity is not signed in on this machine.');
    }

    // Codex: `codex login status` exits 0 when logged in.
    return probed.code === 0
      ? result('connected', 'Codex reports a login for this account.')
      : result('not_connected', 'Codex is not logged in for this account.');
  }
}

function claudeLoggedIn(stdout: string): boolean | undefined {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1)) as { loggedIn?: unknown };
    return typeof parsed.loggedIn === 'boolean' ? parsed.loggedIn : undefined;
  } catch {
    return undefined;
  }
}
