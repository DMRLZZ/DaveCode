import { mkdirSync } from 'node:fs';
import { loadConfig } from './config/loader';
import type { DaveConfig, DaveConfigInput } from './config/schema';
import {
  projectOverridesRouting,
  type RoutingUpdate,
  type RoutingUpdateResult,
  writeGlobalRouting,
} from './config/writer';
import { EventBus } from './events';
import { ChromiumProfileManager } from './identity/chromium';
import { Keyring } from './identity/keyring';
import { SandboxManager } from './identity/sandbox';
import { davecodeHome, type GlobalPaths, globalPaths } from './paths';
import { createProviders } from './providers/registry';
import { UsageTracker } from './rate-limiter/tracker';
import { type Clock, QuotaEngine } from './rate-limiter/window';
import { Router } from './router/router';
import { AccountRepository } from './storage/accounts';
import { AuditLog } from './storage/audit';
import { type Database, openDatabase } from './storage/database';
import { UsageRepository } from './storage/usage';
import type { Provider, ProviderKind } from './types';

export interface CreateEngineOptions {
  /** DaveCode home (default: `env.DAVECODE_HOME` or `~/.davecode`). */
  home?: string;
  /** Repository whose `.davecode/config.json` is layered over the global config. */
  projectRoot?: string;
  /** Environment for `DAVECODE_*` overrides and `DAVECODE_MASTER_KEY` (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Provider adapters by kind (default: every built-in adapter from `createProviders()`). */
  providers?: Map<ProviderKind, Provider>;
  /** Programmatic config overrides, applied after files and env vars. */
  config?: DaveConfigInput;
  /** SQLite path (default `<home>/state.db`); `':memory:'` for ephemeral engines. */
  databasePath?: string;
  /** Clock shared by quotas, cooldowns and timestamps (tests). */
  clock?: Clock;
}

/** Fully wired DaveCode core, shared by the gateway, CLI and runner. */
export interface Engine {
  config: DaveConfig;
  home: string;
  paths: GlobalPaths;
  projectRoot?: string;
  /** Epoch ms when the engine was created. */
  startedAt: number;
  db: Database;
  events: EventBus;
  accounts: AccountRepository;
  usage: UsageRepository;
  audit: AuditLog;
  keyring: Keyring;
  sandboxes: SandboxManager;
  chromium: ChromiumProfileManager;
  quota: QuotaEngine;
  tracker: UsageTracker;
  router: Router;
  providers: Map<ProviderKind, Provider>;
  /**
   * Replaces the route list (and optionally the default route): persists it to the **global**
   * `config.json` (other keys preserved, atomic write) and updates `config.routing` in place,
   * so the router, which reads `config.routing` on every request, uses it immediately.
   */
  updateRouting(
    update: RoutingUpdate,
  ): Promise<RoutingUpdateResult & { shadowedByProject: boolean }>;
  /** Close the database. Safe to call more than once. */
  close(): void;
}

/** Load config, open storage and wire identity, quotas and the router. */
export function createEngine(options: CreateEngineOptions = {}): Engine {
  const env = options.env ?? process.env;
  const home = options.home ?? davecodeHome(env);
  const clock = options.clock ?? Date.now;
  const config = loadConfig({
    home,
    env,
    ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
    ...(options.config ? { overrides: options.config } : {}),
  });
  const paths = globalPaths(home);
  mkdirSync(home, { recursive: true });

  const db = openDatabase(options.databasePath ?? paths.database);
  try {
    const events = new EventBus();
    const accounts = new AccountRepository(db, clock);
    const usage = new UsageRepository(db);
    const audit = new AuditLog(db, clock);
    const keyring = new Keyring(db, { keyPath: paths.masterKey, env, now: clock });
    const sandboxes = new SandboxManager(paths.sandboxes);
    const chromium = new ChromiumProfileManager({
      root: paths.profiles,
      experimentalEnabled: config.experimental.geminiWeb,
    });
    const quota = new QuotaEngine({ clock });
    const tracker = new UsageTracker({
      usage,
      quota,
      events,
      getAccount: (id) => accounts.get(id),
    });
    tracker.hydrate();
    const providers = options.providers ?? createProviders();
    const router = new Router({
      config,
      accounts,
      providers,
      quota,
      tracker,
      events,
      sandboxes,
      chromium,
      keyring,
      clock,
    });

    let closed = false;
    const engine: Engine = {
      config,
      home,
      paths,
      startedAt: clock(),
      db,
      events,
      accounts,
      usage,
      audit,
      keyring,
      sandboxes,
      chromium,
      quota,
      tracker,
      router,
      providers,
      async updateRouting(update) {
        const result = await writeGlobalRouting(home, update);
        config.routing.routes = result.routes;
        if (update.defaultRoute !== undefined) config.routing.defaultRoute = update.defaultRoute;
        const shadowedByProject = options.projectRoot
          ? await projectOverridesRouting(options.projectRoot)
          : false;
        return { ...result, shadowedByProject };
      },
      close() {
        if (closed) return;
        closed = true;
        db.close();
      },
    };
    if (options.projectRoot) engine.projectRoot = options.projectRoot;
    return engine;
  } catch (err) {
    db.close();
    throw err;
  }
}
