import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { type DaveConfig, loadConfig, openDatabase } from '@davecode/core';
import { connectHost, GatewayClient } from '../client';
import { type CliContext, printJson } from '../context';
import { EXIT } from '../errors';
import { which } from '../lib/proc';
import { detectProjectRoot, resolveDashboardDir } from '../runtime';
import { padEnd } from '../ui/format';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

/** Everything doctor touches outside its own logic, injectable for tests. */
export interface DoctorProbes {
  nodeVersion: string;
  loadConfig(): DaveConfig;
  /** Open an in-memory database; resolves with a detail string. */
  loadSqlite(): Promise<string>;
  /** Throws when `dir` cannot be created or written. */
  checkWritable(dir: string): Promise<void>;
  exists(path: string): boolean;
  portInUse(host: string, port: number): Promise<boolean>;
  /** Version of the DaveCode gateway answering on `baseUrl`, if any. */
  gatewayVersion(baseUrl: string, token?: string): Promise<string | undefined>;
  which(command: string): string | undefined;
  /** True when `url` answers with any HTTP response within the timeout. */
  reachable(url: string): Promise<boolean>;
  dashboardDir(): string | undefined;
}

export interface DoctorInput {
  home: string;
  env: NodeJS.ProcessEnv;
}

const MIN_NODE: [number, number] = [22, 12];

export function nodeVersionOk(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

const OLLAMA_URL = 'http://localhost:11434';

export async function runDoctor(input: DoctorInput, probes: DoctorProbes): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = (r: CheckResult) => results.push(r);

  add(
    nodeVersionOk(probes.nodeVersion)
      ? { id: 'node', label: 'Node.js', status: 'ok', detail: probes.nodeVersion }
      : {
          id: 'node',
          label: 'Node.js',
          status: 'fail',
          detail: `${probes.nodeVersion} (needs ${MIN_NODE.join('.')}+)`,
          fix: 'Install Node.js 22.12 or newer: https://nodejs.org',
        },
  );

  let config: DaveConfig | undefined;
  try {
    config = probes.loadConfig();
    add({ id: 'config', label: 'Config', status: 'ok', detail: 'valid' });
  } catch (err) {
    add({
      id: 'config',
      label: 'Config',
      status: 'fail',
      detail: (err as Error).message.split('\n').slice(0, 3).join(' '),
      fix: 'Fix the file named above; `davecode config path` lists every config location.',
    });
  }

  try {
    add({ id: 'sqlite', label: 'better-sqlite3', status: 'ok', detail: await probes.loadSqlite() });
  } catch (err) {
    add({
      id: 'sqlite',
      label: 'better-sqlite3',
      status: 'fail',
      detail: `cannot load: ${(err as Error).message.split('\n')[0]}`,
      fix: 'Rebuild the native module: pnpm rebuild better-sqlite3 (needs a C++ toolchain if no prebuilt binary matches your Node version).',
    });
  }

  try {
    await probes.checkWritable(input.home);
    add({ id: 'home', label: 'Home directory', status: 'ok', detail: `${input.home} is writable` });
  } catch (err) {
    add({
      id: 'home',
      label: 'Home directory',
      status: 'fail',
      detail: `${input.home} is not writable (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`,
      fix: 'Fix the permissions or point DaveCode elsewhere with --home <dir> / DAVECODE_HOME.',
    });
  }

  const keyPath = join(input.home, 'master.key');
  if (input.env.DAVECODE_MASTER_KEY) {
    add({
      id: 'master-key',
      label: 'Master key',
      status: 'ok',
      detail: 'from DAVECODE_MASTER_KEY',
    });
  } else if (probes.exists(keyPath)) {
    add({ id: 'master-key', label: 'Master key', status: 'ok', detail: keyPath });
  } else {
    add({
      id: 'master-key',
      label: 'Master key',
      status: 'warn',
      detail: 'not created yet',
      fix: 'It is generated on first use (davecode start or accounts add). Back it up: without it stored secrets cannot be decrypted.',
    });
  }

  if (config) {
    const { host, port, authToken } = config.server;
    const baseUrl = `http://${connectHost(host)}:${port}`;
    if (!(await probes.portInUse(host, port))) {
      add({ id: 'port', label: 'Gateway port', status: 'ok', detail: `${host}:${port} is free` });
    } else {
      const version = await probes.gatewayVersion(baseUrl, authToken);
      add(
        version
          ? {
              id: 'port',
              label: 'Gateway port',
              status: 'ok',
              detail: `DaveCode ${version} is already running at ${baseUrl}`,
            }
          : {
              id: 'port',
              label: 'Gateway port',
              status: 'fail',
              detail: `${host}:${port} is used by another program`,
              fix: `Stop it, or use another port: davecode start --port ${port + 1} (or DAVECODE_PORT).`,
            },
      );
    }
  }

  const tools: Array<{ cmd: string; label: string; required: boolean; why: string; fix: string }> =
    [
      {
        cmd: 'git',
        label: 'git',
        required: true,
        why: 'needed by the autonomous runner (task branches and merges)',
        fix: 'Install git: https://git-scm.com/downloads',
      },
      {
        cmd: 'claude',
        label: 'Claude Code CLI',
        required: false,
        why: 'only for claude-cli accounts',
        fix: 'npm install -g @anthropic-ai/claude-code',
      },
      {
        cmd: 'codex',
        label: 'Codex CLI',
        required: false,
        why: 'only for codex-cli accounts',
        fix: 'npm install -g @openai/codex',
      },
      {
        cmd: 'gh',
        label: 'GitHub CLI',
        required: false,
        why: 'optional, for opening pull requests',
        fix: 'Install gh: https://cli.github.com',
      },
    ];
  for (const tool of tools) {
    const path = probes.which(tool.cmd);
    add(
      path
        ? { id: tool.cmd, label: tool.label, status: 'ok', detail: path }
        : {
            id: tool.cmd,
            label: tool.label,
            status: tool.required ? 'fail' : 'warn',
            detail: `not found on PATH (${tool.why})`,
            fix: tool.fix,
          },
    );
  }

  add(
    (await probes.reachable(`${OLLAMA_URL}/api/tags`))
      ? { id: 'ollama', label: 'Ollama', status: 'ok', detail: `reachable at ${OLLAMA_URL}` }
      : {
          id: 'ollama',
          label: 'Ollama',
          status: 'warn',
          detail: `not reachable at ${OLLAMA_URL} (optional, for local models)`,
          fix: 'Start it with `ollama serve`, then add it: davecode accounts add --provider openai-compatible --base-url http://localhost:11434/v1',
        },
  );

  const dashboard = probes.dashboardDir();
  add(
    dashboard
      ? { id: 'dashboard', label: 'Dashboard build', status: 'ok', detail: dashboard }
      : {
          id: 'dashboard',
          label: 'Dashboard build',
          status: 'warn',
          detail: 'not built (the gateway still works without it)',
          fix: 'pnpm --filter @davecode/ui build',
        },
  );

  return results;
}

// ---------------------------------------------------------------------------
// Real probes
// ---------------------------------------------------------------------------

function portInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      resolve(err.code === 'EADDRINUSE' || err.code === 'EACCES');
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(false));
    });
  });
}

export function defaultProbes(
  ctx: Pick<CliContext, 'home' | 'env'>,
  projectRoot?: string,
): DoctorProbes {
  return {
    nodeVersion: process.version,
    loadConfig: () =>
      loadConfig({ home: ctx.home, env: ctx.env, ...(projectRoot ? { projectRoot } : {}) }),
    async loadSqlite() {
      const db = openDatabase(':memory:');
      try {
        const row = db.prepare('select sqlite_version() as v').get() as { v: string };
        return `loads (SQLite ${row.v})`;
      } finally {
        db.close();
      }
    },
    async checkWritable(dir) {
      await mkdir(dir, { recursive: true });
      const probe = join(dir, `.doctor-${process.pid}.tmp`);
      await writeFile(probe, 'ok');
      await rm(probe, { force: true });
    },
    exists: existsSync,
    portInUse,
    async gatewayVersion(baseUrl, token) {
      const client = new GatewayClient({ baseUrl, ...(token ? { token } : {}) });
      try {
        return (await client.health(800))?.version;
      } catch {
        return undefined;
      }
    },
    which: (cmd) => which(cmd, ctx.env),
    async reachable(url) {
      try {
        await fetch(url, { signal: AbortSignal.timeout(800) });
        return true;
      } catch {
        return false;
      }
    },
    dashboardDir: () => resolveDashboardDir(ctx.env),
  };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function renderDoctor(ctx: Pick<CliContext, 'theme'>, results: CheckResult[]): string[] {
  const { theme } = ctx;
  const lines = [theme.bold(theme.accent('DaveCode doctor')), ''];
  const width = Math.max(...results.map((r) => r.label.length)) + 2;
  for (const r of results) {
    const mark =
      r.status === 'ok'
        ? theme.ok(theme.glyph.ok)
        : r.status === 'warn'
          ? theme.warn(theme.glyph.warn)
          : theme.error(theme.glyph.fail);
    const detail = r.status === 'ok' ? theme.dim(r.detail) : r.detail;
    lines.push(`  ${mark} ${padEnd(r.label, width)} ${detail}`);
    if (r.fix && r.status !== 'ok')
      lines.push(`     ${' '.repeat(width)}${theme.dim(`fix: ${r.fix}`)}`);
  }
  const count = (s: CheckStatus) => results.filter((r) => r.status === s).length;
  const fails = count('fail');
  const warns = count('warn');
  lines.push('');
  lines.push(
    [
      theme.ok(`${count('ok')} ok`),
      warns ? theme.warn(`${warns} warning${warns === 1 ? '' : 's'}`) : `${warns} warnings`,
      fails ? theme.error(`${fails} failure${fails === 1 ? '' : 's'}`) : '0 failures',
    ].join(theme.dim(' · ')),
  );
  return lines;
}

export async function doctorCommand(
  ctx: CliContext,
  probes?: Partial<DoctorProbes>,
): Promise<number> {
  const projectRoot = await detectProjectRoot(ctx.cwd, ctx.home);
  const merged: DoctorProbes = { ...defaultProbes(ctx, projectRoot), ...probes };
  const results = await runDoctor({ home: ctx.home, env: ctx.env }, merged);
  const failed = results.some((r) => r.status === 'fail');
  if (ctx.json) {
    printJson(ctx, { ok: !failed, checks: results });
  } else {
    for (const line of renderDoctor(ctx, results)) ctx.out(line);
  }
  return failed ? EXIT.failure : EXIT.ok;
}
