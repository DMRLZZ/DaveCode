import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

export interface PackageJson {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
}

export function readPackageJson(root: string): PackageJson | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return value && typeof value === 'object' ? (value as PackageJson) : undefined;
  } catch {
    return undefined;
  }
}

/** From `packageManager` in package.json, then lockfiles; npm otherwise. */
export function detectPackageManager(root: string, pkg?: PackageJson): PackageManager {
  const declared = pkg?.packageManager?.split('@')[0];
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'bun' || declared === 'npm') {
    return declared;
  }
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

const CANDIDATES = {
  lint: ['lint', 'lint:check', 'check:lint'],
  typecheck: ['typecheck', 'type-check', 'check-types', 'check:types', 'types', 'tsc'],
  test: ['test', 'test:unit', 'test:ci'],
} as const;

/** npm's placeholder `test` script, which always fails. */
const NPM_PLACEHOLDER = /no test specified/i;

export function runScript(pm: PackageManager, script: string): string {
  if (script === 'test') return `${pm} test`;
  switch (pm) {
    case 'npm':
      return `npm run ${script}`;
    case 'bun':
      return `bun run ${script}`;
    default:
      return `${pm} ${script}`;
  }
}

export interface ValidateCommands {
  lint?: string;
  typecheck?: string;
  test?: string;
}

/** `runner.validate` commands for the lint/typecheck/test scripts a package.json defines. */
export function detectValidateCommands(
  pkg: PackageJson | undefined,
  pm: PackageManager,
): ValidateCommands {
  const scripts = pkg?.scripts ?? {};
  const found: ValidateCommands = {};
  for (const [kind, names] of Object.entries(CANDIDATES) as Array<
    [keyof ValidateCommands, readonly string[]]
  >) {
    const script = names.find((name) => {
      const body = scripts[name];
      return typeof body === 'string' && body.trim() !== '' && !NPM_PLACEHOLDER.test(body);
    });
    if (script) found[kind] = runScript(pm, script);
  }
  return found;
}

/** Starter `.davecode/config.json` content. */
export function starterConfig(validate: ValidateCommands): Record<string, unknown> {
  return { runner: { validate, judge: { kind: 'none' } } };
}
