import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { atomicWriteFile, isNodeError } from '../brain/fs-util';
import { type LockOptions, withFileLock } from '../brain/lock';
import { globalPaths, projectPaths } from '../paths';
import type { Route } from '../types';
import { ConfigError } from './loader';
import { configSchema } from './schema';

type PlainObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is PlainObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export interface RoutingUpdate {
  /** The complete new route list (replaces the old one). */
  routes: Route[];
  /** New default route; omitted leaves the stored value untouched. */
  defaultRoute?: string;
}

export interface RoutingUpdateResult {
  /** The global config file that was written. */
  path: string;
  routes: Route[];
  defaultRoute: string;
}

/**
 * Read-modify-write of the global `config.json`: only `routing.routes` (and `routing.defaultRoute`)
 * change; every other key, including the rest of `routing`, is preserved. The file is replaced
 * atomically while holding a lock file, so concurrent writers (another gateway, the CLI) cannot
 * lose each other's changes and readers never see a torn file. An existing file that is malformed
 * or invalid is never overwritten: a {@link ConfigError} is thrown instead.
 */
export async function writeGlobalRouting(
  home: string,
  update: RoutingUpdate,
  lock: LockOptions = {},
): Promise<RoutingUpdateResult> {
  const path = globalPaths(home).config;
  return withFileLock(
    `${path}.lock`,
    async () => {
      let current: PlainObject = {};
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isPlainObject(parsed)) throw new ConfigError(path, 'expected a JSON object');
        current = parsed;
      } catch (err) {
        if (err instanceof ConfigError) throw err;
        if (!isNodeError(err, 'ENOENT')) {
          throw new ConfigError(path, `cannot update this file: ${(err as Error).message}`, {
            cause: err,
          });
        }
      }

      const routing = isPlainObject(current.routing) ? current.routing : {};
      const next: PlainObject = {
        ...current,
        routing: {
          ...routing,
          routes: update.routes,
          ...(update.defaultRoute !== undefined ? { defaultRoute: update.defaultRoute } : {}),
        },
      };
      const checked = configSchema.safeParse(next);
      if (!checked.success) throw new ConfigError(path, z.prettifyError(checked.error));

      await atomicWriteFile(path, `${JSON.stringify(next, null, 2)}\n`);
      return {
        path,
        routes: checked.data.routing.routes,
        defaultRoute: checked.data.routing.defaultRoute,
      };
    },
    lock,
  );
}

/**
 * True when `<project>/.davecode/config.json` sets `routing.routes` or `routing.defaultRoute`:
 * the project layer wins over the global file, so a change written globally would not take
 * effect after a restart in that project.
 */
export async function projectOverridesRouting(projectRoot: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(projectPaths(projectRoot).config, 'utf8'));
    const routing = isPlainObject(parsed) ? parsed.routing : undefined;
    return isPlainObject(routing) && ('routes' in routing || 'defaultRoute' in routing);
  } catch {
    return false;
  }
}
