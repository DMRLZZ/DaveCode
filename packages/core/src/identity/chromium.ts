import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { globalPaths } from '../paths';
import { accountDir } from './sandbox';

/** Minimal view of a Playwright persistent `BrowserContext` (playwright-core is optional). */
export interface ChromiumContext {
  close(): Promise<void>;
  newPage(): Promise<unknown>;
  pages(): unknown[];
}

export interface ChromiumLaunchOptions {
  /** Run without a visible window (default true). Use false for the interactive first login. */
  headless?: boolean;
  /** Extra Chromium command-line switches. */
  args?: string[];
}

export interface ChromiumProfileManagerOptions {
  /** Directory holding one `userDataDir` per account (default `globalPaths().profiles`). */
  root?: string;
  /** Mirror of `config.experimental.geminiWeb`; launching is refused when false. */
  experimentalEnabled: boolean;
  /** Module loader for `playwright-core` (injectable for tests). */
  importPlaywright?: () => Promise<unknown>;
}

/** Thrown when a browser feature is used while its experimental flag is off. */
export class ExperimentalDisabledError extends Error {
  readonly code = 'experimental_disabled';
  constructor(message: string) {
    super(message);
    this.name = 'ExperimentalDisabledError';
  }
}

/** Thrown when the optional `playwright-core` peer dependency is missing or unusable. */
export class ChromiumUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ChromiumUnavailableError';
  }
}

type LaunchPersistentContext = (
  userDataDir: string,
  options: { headless: boolean; args?: string[] },
) => Promise<ChromiumContext>;

function extractLauncher(mod: unknown): LaunchPersistentContext | undefined {
  const candidates = [mod, (mod as { default?: unknown } | null)?.default];
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const chromium = (candidate as { chromium?: unknown }).chromium;
    if (typeof chromium !== 'object' || chromium === null) continue;
    const launch = (chromium as { launchPersistentContext?: unknown }).launchPersistentContext;
    if (typeof launch === 'function') {
      return launch.bind(chromium) as LaunchPersistentContext;
    }
  }
  return undefined;
}

const PLAYWRIGHT_MODULE = 'playwright-core';

const defaultImport = (): Promise<unknown> => import(/* @vite-ignore */ PLAYWRIGHT_MODULE);

/**
 * Isolated Chromium profiles (`~/.davecode/profiles/<accountId>`) for experimental
 * browser-backed providers. Each account gets its own `userDataDir`, so cookies and
 * sessions never mix.
 */
export class ChromiumProfileManager {
  readonly root: string;
  private readonly experimentalEnabled: boolean;
  private readonly importPlaywright: () => Promise<unknown>;

  constructor(options: ChromiumProfileManagerOptions) {
    this.root = resolve(options.root ?? globalPaths().profiles);
    this.experimentalEnabled = options.experimentalEnabled;
    this.importPlaywright = options.importPlaywright ?? defaultImport;
  }

  /** The account's `userDataDir` (not created). */
  profileDir(accountId: string): string {
    return accountDir(this.root, accountId);
  }

  /** Create the profile directory if needed and return it. */
  ensure(accountId: string): string {
    const dir = this.profileDir(accountId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** Delete the profile (cookies, local storage, cache). */
  remove(accountId: string): void {
    rmSync(this.profileDir(accountId), { recursive: true, force: true });
  }

  /** Launch a persistent Chromium context bound to the account's profile. */
  async launch(accountId: string, options: ChromiumLaunchOptions = {}): Promise<ChromiumContext> {
    if (!this.experimentalEnabled) {
      throw new ExperimentalDisabledError(
        'Browser-backed providers are experimental and disabled. Set experimental.geminiWeb to true to opt in (this may violate the provider’s Terms of Service).',
      );
    }
    const dir = this.ensure(accountId);

    let mod: unknown;
    try {
      mod = await this.importPlaywright();
    } catch (err) {
      throw new ChromiumUnavailableError(
        'playwright-core is not installed. Install it with `pnpm add playwright-core` and download a browser with `npx playwright install chromium`.',
        { cause: err },
      );
    }
    const launch = extractLauncher(mod);
    if (!launch) {
      throw new ChromiumUnavailableError(
        'playwright-core was found but does not expose chromium.launchPersistentContext',
      );
    }
    const launchOptions: { headless: boolean; args?: string[] } = {
      headless: options.headless ?? true,
    };
    if (options.args) launchOptions.args = options.args;
    return launch(dir, launchOptions);
  }
}
