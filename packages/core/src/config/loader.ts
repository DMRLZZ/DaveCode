import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { davecodeHome, globalPaths, projectPaths } from '../paths';
import { configSchema, type DaveConfig, type DaveConfigInput } from './schema';

/** Thrown when a config layer cannot be read, parsed or validated. */
export class ConfigError extends Error {
  /** File path or environment variable name the problem came from. */
  readonly source: string;

  constructor(source: string, message: string, options?: { cause?: unknown }) {
    super(`Invalid DaveCode config (${source}):\n${message}`, options);
    this.name = 'ConfigError';
    this.source = source;
  }
}

export interface LoadConfigOptions {
  /** DaveCode home (defaults to `DAVECODE_HOME` or `~/.davecode`). */
  home?: string;
  /** Repository root whose `.davecode/config.json` is layered on top of the global config. */
  projectRoot?: string;
  /** Environment used for `DAVECODE_*` overrides (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Programmatic overrides applied last (e.g. CLI flags). */
  overrides?: DaveConfigInput;
  /**
   * Receives a message for every project-config key that was ignored because project files are
   * untrusted. Defaults to a one-time process warning on stderr per distinct message.
   */
  onWarning?: (message: string) => void;
}

type PlainObject = Record<string, unknown>;

/**
 * Keys a repository's `.davecode/config.json` may set. A cloned repository is untrusted input,
 * so everything not listed here is ignored (with a warning): the bind address and port, the auth
 * token, `experimental.*` opt-ins, judge endpoints and the runner's command and tool allow-lists.
 * `true` allows the whole subtree; an object allows only the keys it names.
 */
export const PROJECT_SETTABLE_KEYS = {
  logLevel: true,
  routing: true,
  goal: true,
  runner: {
    maxRepairCycles: true,
    branchPrefix: true,
    baseBranch: true,
    route: true,
    executor: true,
    pullRequests: true,
    commitBrain: true,
    commandTimeoutMs: true,
    idlePollMs: true,
    maxIterations: true,
    maxTaskTokens: true,
    validate: true,
    claudeCli: { accountId: true, model: true, timeoutMs: true },
    judge: { kind: true, model: true, threshold: true },
  },
} as const;

type SettableTree = { readonly [key: string]: true | SettableTree };

/** Split a project layer into the keys it may set and the dotted paths that were dropped. */
export function filterProjectLayer(layer: PlainObject): {
  allowed: PlainObject;
  dropped: string[];
} {
  const dropped: string[] = [];
  const walk = (value: PlainObject, tree: SettableTree, prefix: string): PlainObject => {
    const out: PlainObject = {};
    for (const [key, v] of Object.entries(value)) {
      const rule = Object.hasOwn(tree, key) ? tree[key] : undefined;
      const path = prefix ? `${prefix}.${key}` : key;
      if (rule === true) {
        out[key] = v;
      } else if (rule && isPlainObject(v)) {
        const inner = walk(v, rule, path);
        if (Object.keys(inner).length > 0) out[key] = inner;
      } else {
        dropped.push(path);
      }
    }
    return out;
  };
  return { allowed: walk(layer, PROJECT_SETTABLE_KEYS as SettableTree, ''), dropped };
}

const warned = new Set<string>();
function defaultWarn(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  process.emitWarning(message, 'DaveCodeConfigWarning');
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep-merge plain objects; arrays and primitives in `override` replace `base`. */
export function deepMerge(base: PlainObject, override: PlainObject): PlainObject {
  const out: PlainObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out;
}

function readLayer(path: string, project?: (dropped: string[]) => void): PlainObject | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ConfigError(path, `cannot read file: ${(err as Error).message}`, { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(path, `malformed JSON: ${(err as Error).message}`, { cause: err });
  }
  if (!isPlainObject(parsed)) throw new ConfigError(path, 'expected a JSON object');
  let layer: PlainObject = parsed;
  if (project) {
    const { allowed, dropped } = filterProjectLayer(parsed);
    if (dropped.length > 0) project(dropped);
    layer = allowed;
  }
  // Validate each layer on its own so errors point at the file that caused them.
  const result = configSchema.safeParse(layer);
  if (!result.success) throw new ConfigError(path, z.prettifyError(result.error));
  return layer;
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', '']);

function parseBool(name: string, value: string): boolean {
  const v = value.trim().toLowerCase();
  if (TRUE_VALUES.has(v)) return true;
  if (FALSE_VALUES.has(v)) return false;
  throw new ConfigError(name, `expected a boolean (true/false/1/0), got "${value}"`);
}

function parsePort(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ConfigError(name, `expected a port number between 1 and 65535, got "${value}"`);
  }
  return n;
}

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/** Translate `DAVECODE_*` environment variables into a config layer. */
export function envLayer(env: NodeJS.ProcessEnv): PlainObject {
  const server: PlainObject = {};
  const experimental: PlainObject = {};
  const layer: PlainObject = {};

  if (env.DAVECODE_HOST) server.host = env.DAVECODE_HOST;
  if (env.DAVECODE_PORT) server.port = parsePort('DAVECODE_PORT', env.DAVECODE_PORT);
  if (env.DAVECODE_AUTH_TOKEN) server.authToken = env.DAVECODE_AUTH_TOKEN;
  if (env.DAVECODE_LOG_LEVEL) {
    const level = env.DAVECODE_LOG_LEVEL.trim().toLowerCase();
    if (!(LOG_LEVELS as readonly string[]).includes(level)) {
      throw new ConfigError(
        'DAVECODE_LOG_LEVEL',
        `expected one of ${LOG_LEVELS.join(', ')}, got "${env.DAVECODE_LOG_LEVEL}"`,
      );
    }
    layer.logLevel = level;
  }
  if (env.DAVECODE_EXPERIMENTAL_GEMINI_WEB !== undefined) {
    experimental.geminiWeb = parseBool(
      'DAVECODE_EXPERIMENTAL_GEMINI_WEB',
      env.DAVECODE_EXPERIMENTAL_GEMINI_WEB,
    );
  }
  if (env.DAVECODE_EXPERIMENTAL_MULTI_ACCOUNT_ROTATION !== undefined) {
    experimental.multiAccountRotation = parseBool(
      'DAVECODE_EXPERIMENTAL_MULTI_ACCOUNT_ROTATION',
      env.DAVECODE_EXPERIMENTAL_MULTI_ACCOUNT_ROTATION,
    );
  }

  if (Object.keys(server).length > 0) layer.server = server;
  if (Object.keys(experimental).length > 0) layer.experimental = experimental;
  return layer;
}

/**
 * Resolve the effective configuration. Later layers win:
 * built-in defaults ← `~/.davecode/config.json` ← `<project>/.davecode/config.json`
 * ← `DAVECODE_*` env vars ← `overrides`. Objects deep-merge, arrays replace.
 * Project files can only set the keys in {@link PROJECT_SETTABLE_KEYS}; others are ignored with a
 * warning. Missing files are skipped; invalid ones throw a {@link ConfigError} naming the file.
 */
export function loadConfig(options: LoadConfigOptions = {}): DaveConfig {
  const env = options.env ?? process.env;
  const home = options.home ?? davecodeHome(env);

  let merged: PlainObject = {};
  const globalLayer = readLayer(globalPaths(home).config);
  if (globalLayer) merged = deepMerge(merged, globalLayer);
  if (options.projectRoot) {
    const projectFile = projectPaths(options.projectRoot).config;
    const warn = options.onWarning ?? defaultWarn;
    const projectLayer = readLayer(projectFile, (dropped) =>
      warn(
        `Ignored ${dropped.join(', ')} in ${projectFile}: project config cannot set these keys. ` +
          'Set them in your user config (~/.davecode/config.json) or with DAVECODE_* environment variables.',
      ),
    );
    if (projectLayer) merged = deepMerge(merged, projectLayer);
  }
  merged = deepMerge(merged, envLayer(env));
  if (options.overrides) merged = deepMerge(merged, options.overrides as PlainObject);

  const result = configSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigError('merged configuration', z.prettifyError(result.error));
  }
  return result.data;
}
