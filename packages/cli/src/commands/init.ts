import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { configSchema, ProjectBrain, projectPaths } from '@davecode/core';
import { type CliContext, printJson } from '../context';
import { CliError, EXIT } from '../errors';
import { PromptCancelledError, type Prompter } from '../lib/prompter';
import {
  detectPackageManager,
  detectValidateCommands,
  readPackageJson,
  starterConfig,
} from '../lib/validate-detect';
import { detectProjectRoot } from '../runtime';

export interface InitOptions {
  name?: string;
  /** `--config` writes the starter config without asking; `--no-config` skips it. */
  config?: boolean;
}

export interface InitDeps {
  prompter?: Prompter;
}

const LOCK_IGNORE = '.davecode/.lock';

/** Make sure `.davecode/.lock` is git-ignored. Returns true when `.gitignore` changed. */
export function ensureLockIgnored(root: string): boolean {
  const path = join(root, '.gitignore');
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(LOCK_IGNORE) || lines.includes('.davecode/') || lines.includes('.davecode')) {
    return false;
  }
  const prefix = current === '' || current.endsWith('\n') ? current : `${current}\n`;
  writeFileSync(
    path,
    `${prefix}${current === '' ? '' : '\n'}# DaveCode runtime lock\n${LOCK_IGNORE}\n`,
  );
  return true;
}

export async function initCommand(
  ctx: CliContext,
  opts: InitOptions,
  deps: InitDeps = {},
): Promise<number> {
  const root = (await detectProjectRoot(ctx.cwd, ctx.home)) ?? ctx.cwd;
  const paths = projectPaths(root);
  const pkg = readPackageJson(root);
  const name = opts.name?.trim() || pkg?.name || basename(root);

  const before = {
    state: existsSync(paths.state),
    architecture: existsSync(paths.architecture),
    taskGraph: existsSync(paths.taskGraph),
  };
  await ProjectBrain.init(root, { name });
  const created = Object.entries(before)
    .filter(([, existed]) => !existed)
    .map(([file]) => file);

  // Starter config with validation commands detected from package.json.
  const pm = detectPackageManager(root, pkg);
  const validate = detectValidateCommands(pkg, pm);
  let configWritten = false;
  let configSkipped: string | undefined;
  if (existsSync(paths.config)) {
    configSkipped = 'exists';
  } else if (opts.config === false) {
    configSkipped = 'declined';
  } else {
    let write = opts.config === true;
    if (!write && ctx.interactive) {
      const prompter =
        deps.prompter ??
        (await import('../tui/prompts')).createInkPrompter({
          stdout: ctx.io.stdout,
          stdin: ctx.io.stdin,
          theme: ctx.theme,
        });
      const summary = Object.entries(validate)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      try {
        write = await prompter.confirm(
          summary
            ? `Write .davecode/config.json with runner.validate (${summary})?`
            : 'Write a starter .davecode/config.json (no lint/typecheck/test scripts found)?',
          true,
        );
      } catch (err) {
        if (!(err instanceof PromptCancelledError)) throw err;
      }
    }
    if (write) {
      const content = starterConfig(validate);
      const check = configSchema.safeParse(content);
      if (!check.success) throw new CliError('Generated config is invalid (please report a bug)');
      writeFileSync(paths.config, `${JSON.stringify(content, null, 2)}\n`);
      configWritten = true;
    } else {
      configSkipped = ctx.interactive ? 'declined' : 'non-interactive';
    }
  }

  const ignoreUpdated = existsSync(join(root, '.git')) ? ensureLockIgnored(root) : false;

  if (ctx.json) {
    printJson(ctx, {
      root,
      name,
      created,
      config: configWritten ? paths.config : null,
      validate,
      gitignoreUpdated: ignoreUpdated,
    });
    return EXIT.ok;
  }

  const { theme } = ctx;
  const rel = (p: string) => relative(ctx.cwd, p) || '.';
  ctx.out(
    `${theme.ok(theme.glyph.ok)} Project brain ready for ${theme.bold(name)} ${theme.dim(rel(paths.dir))}`,
  );
  const files: Array<[string, string, boolean]> = [
    ['STATE.md', paths.state, before.state],
    ['ARCHITECTURE.md', paths.architecture, before.architecture],
    ['TASK_GRAPH.json', paths.taskGraph, before.taskGraph],
  ];
  for (const [label, , existed] of files) {
    ctx.out(`  ${existed ? theme.dim('kept   ') : theme.accent('created')} ${label}`);
  }
  if (configWritten) {
    ctx.out(`  ${theme.accent('created')} config.json`);
    for (const [kind, command] of Object.entries(validate)) {
      ctx.out(theme.dim(`          runner.validate.${kind} = ${command}`));
    }
  } else if (configSkipped === 'exists') {
    ctx.out(`  ${theme.dim('kept   ')} config.json`);
  } else if (configSkipped === 'non-interactive') {
    ctx.out(theme.dim('  config.json not written (pass --config to create a starter config)'));
  }
  if (ignoreUpdated)
    ctx.out(`  ${theme.accent('updated')} .gitignore ${theme.dim(`(${LOCK_IGNORE})`)}`);

  ctx.out();
  ctx.out(theme.dim('Next:'));
  ctx.out(`  ${theme.accent('davecode tasks add setup "Describe the first task"')}`);
  ctx.out(`  ${theme.accent('davecode start')}`);
  return EXIT.ok;
}
