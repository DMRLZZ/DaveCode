import { existsSync } from 'node:fs';
import { globalPaths, loadConfig, projectPaths } from '@davecode/core';
import { type CliContext, printJson } from '../context';
import { CliError, EXIT } from '../errors';
import { getPath, redact } from '../lib/redact';
import { detectProjectRoot } from '../runtime';
import { padEnd } from '../ui/format';

async function resolved(ctx: CliContext) {
  const projectRoot = await detectProjectRoot(ctx.cwd, ctx.home);
  const config = loadConfig({
    home: ctx.home,
    env: ctx.env,
    ...(projectRoot ? { projectRoot } : {}),
  });
  return { projectRoot, config };
}

/** Which `DAVECODE_*` variables are currently overriding config (names only, never values). */
function envOverrides(env: NodeJS.ProcessEnv): string[] {
  return [
    'DAVECODE_HOST',
    'DAVECODE_PORT',
    'DAVECODE_AUTH_TOKEN',
    'DAVECODE_LOG_LEVEL',
    'DAVECODE_EXPERIMENTAL_GEMINI_WEB',
    'DAVECODE_EXPERIMENTAL_MULTI_ACCOUNT_ROTATION',
    'DAVECODE_MASTER_KEY',
  ].filter((name) => env[name] !== undefined && env[name] !== '');
}

export async function configPath(ctx: CliContext): Promise<number> {
  const projectRoot = await detectProjectRoot(ctx.cwd, ctx.home);
  const paths = globalPaths(ctx.home);
  const project = projectRoot ? projectPaths(projectRoot) : undefined;
  const files = {
    home: paths.home,
    globalConfig: paths.config,
    projectConfig: project?.config ?? null,
    database: paths.database,
    masterKey: paths.masterKey,
    brain: paths.brain,
    sandboxes: paths.sandboxes,
    profiles: paths.profiles,
    projectBrain: project?.dir ?? null,
  };
  if (ctx.json) {
    printJson(ctx, { ...files, envOverrides: envOverrides(ctx.env) });
    return EXIT.ok;
  }
  const { theme } = ctx;
  const row = (label: string, path: string | null, checkExists = true) => {
    if (path === null) {
      ctx.out(`${theme.dim(padEnd(label, 15))} ${theme.dim('(not in a project)')}`);
      return;
    }
    const mark = !checkExists
      ? ''
      : existsSync(path)
        ? ` ${theme.ok(theme.glyph.ok)}`
        : ` ${theme.dim('(missing)')}`;
    ctx.out(`${theme.dim(padEnd(label, 15))} ${path}${mark}`);
  };
  row('home', files.home);
  row('global config', files.globalConfig);
  row('project config', files.projectConfig);
  row('database', files.database);
  row('master key', files.masterKey);
  row('global brain', files.brain);
  row('sandboxes', files.sandboxes);
  row('project brain', files.projectBrain);
  const overrides = envOverrides(ctx.env);
  if (overrides.length > 0) {
    ctx.out();
    ctx.out(theme.dim(`Overridden by environment: ${overrides.join(', ')}`));
  }
  ctx.out();
  ctx.out(
    theme.dim('Later layers win: defaults < global config < project config < env vars < flags.'),
  );
  return EXIT.ok;
}

export async function configShow(ctx: CliContext): Promise<number> {
  const { config } = await resolved(ctx);
  printJson(ctx, redact(config));
  return EXIT.ok;
}

export async function configGet(ctx: CliContext, key: string): Promise<number> {
  const { config } = await resolved(ctx);
  const result = getPath(redact(config), key);
  if (!result.found) {
    throw new CliError(`Unknown config key ${JSON.stringify(key)}`, {
      hint: 'See every key with `davecode config show`.',
    });
  }
  const { value } = result;
  if (ctx.json || (value !== null && typeof value === 'object')) printJson(ctx, value);
  else ctx.out(String(value));
  return EXIT.ok;
}
