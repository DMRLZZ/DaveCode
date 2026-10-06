import { mkdirSync, rmSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { globalPaths } from '../paths';
import type { Account } from '../types';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Windows device names that cannot be used as directory names. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Resolve `<root>/<accountId>`, rejecting ids that are not plain identifiers or that would
 * resolve outside `root` (path traversal, absolute paths, drive letters, reserved names).
 */
export function accountDir(root: string, accountId: string): string {
  if (!SAFE_ID.test(accountId) || RESERVED.test(accountId)) {
    throw new Error(`Invalid account id for an isolated directory: ${JSON.stringify(accountId)}`);
  }
  const base = resolve(root);
  const dir = resolve(base, accountId);
  const rel = relative(base, dir);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Account directory escapes ${base}: ${JSON.stringify(accountId)}`);
  }
  return dir;
}

/**
 * Per-account isolated directories for CLI providers (`~/.davecode/sandboxes/<accountId>`),
 * so accounts never share credentials, caches or rate-limit state.
 */
export class SandboxManager {
  readonly root: string;

  constructor(root: string = globalPaths().sandboxes) {
    this.root = resolve(root);
  }

  /** Path of an account's sandbox (not created). */
  dirFor(accountId: string): string {
    return accountDir(this.root, accountId);
  }

  /** Create the sandbox if needed and return its path. */
  ensure(accountId: string): string {
    const dir = this.dirFor(accountId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** Environment variables that point a CLI provider at the account's sandbox. */
  envFor(account: Pick<Account, 'id' | 'provider'>): Record<string, string> {
    switch (account.provider) {
      case 'claude-cli':
        return { CLAUDE_CONFIG_DIR: this.dirFor(account.id) };
      case 'codex-cli':
        return { CODEX_HOME: this.dirFor(account.id) };
      default:
        return {};
    }
  }

  /** Delete an account's sandbox and everything in it. */
  remove(accountId: string): void {
    rmSync(this.dirFor(accountId), { recursive: true, force: true });
  }
}
