import {
  type Account,
  type AccountUsage,
  createEngine,
  type DaveConfig,
  loadConfig,
  QUOTA_WINDOWS,
  type QuotaWindow,
  type RunnerStatus,
  type WindowUsage,
} from '@davecode/core';
import { findGateway, type GatewayClient, type HealthResponse, targetFor } from '../client';
import { type CliContext, printJson } from '../context';
import { EXIT } from '../errors';
import { detectProjectRoot } from '../runtime';
import {
  bar,
  type Column,
  formatDuration,
  formatTokens,
  levelStyle,
  percent,
  table,
  truncate,
} from '../ui/format';
import type { Theme } from '../ui/theme';

export interface AccountRow {
  account: Account;
  usage: AccountUsage;
}

export interface StatusReport {
  running: boolean;
  /** Where the account data came from. */
  source: 'gateway' | 'local';
  url: string;
  version?: string;
  uptimeSec?: number;
  experimental: DaveConfig['experimental'];
  runner?: RunnerStatus;
  home: string;
  accounts: AccountRow[];
}

function emptyUsage(accountId: string): AccountUsage {
  const windows = Object.fromEntries(
    QUOTA_WINDOWS.map((w) => [w, { window: w, tokens: 0, requests: 0, utilization: 0 }]),
  ) as Record<QuotaWindow, WindowUsage>;
  return { accountId, windows };
}

async function fromGateway(
  client: GatewayClient,
  health: HealthResponse,
  home: string,
): Promise<StatusReport> {
  const [{ accounts }, { usage }, runner] = await Promise.all([
    client.get<{ accounts: Account[] }>('/api/accounts'),
    client.get<{ usage: AccountUsage[] }>('/api/usage'),
    client.get<{ status: RunnerStatus }>('/api/runner').catch(() => undefined),
  ]);
  const byId = new Map(usage.map((u) => [u.accountId, u]));
  return {
    running: true,
    source: 'gateway',
    url: client.baseUrl,
    version: health.version,
    uptimeSec: health.uptimeSec,
    experimental: health.experimental,
    ...(runner ? { runner: runner.status } : {}),
    home,
    accounts: accounts.map((account) => ({
      account,
      usage: byId.get(account.id) ?? emptyUsage(account.id),
    })),
  };
}

/** Read accounts and quota windows straight from `state.db` (no gateway needed). */
export function localStatus(
  ctx: Pick<CliContext, 'home' | 'env'>,
  projectRoot?: string,
): StatusReport {
  const engine = createEngine({
    home: ctx.home,
    env: ctx.env,
    ...(projectRoot ? { projectRoot } : {}),
  });
  try {
    return {
      running: false,
      source: 'local',
      url: targetFor(engine.config).baseUrl,
      experimental: { ...engine.config.experimental },
      home: engine.home,
      accounts: engine.accounts.list().map((account) => ({
        account,
        usage: engine.tracker.usageFor(account),
      })),
    };
  } finally {
    engine.close();
  }
}

export async function gatherStatus(ctx: CliContext): Promise<StatusReport> {
  const projectRoot = await detectProjectRoot(ctx.cwd, ctx.home);
  const config = loadConfig({
    home: ctx.home,
    env: ctx.env,
    ...(projectRoot ? { projectRoot } : {}),
  });
  const gateway = await findGateway(config);
  if (gateway) return fromGateway(gateway.client, gateway.health, ctx.home);
  return localStatus(ctx, projectRoot);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function statusLabel(theme: Theme, account: Account): string {
  switch (account.status) {
    case 'active':
      return theme.ok('active');
    case 'cooldown':
      return theme.warn('cooldown');
    case 'error':
      return theme.error('error');
    default:
      return theme.dim('disabled');
  }
}

/** `████░░░░ 23%` for limited windows, a dim track plus raw tokens when unlimited. */
export function windowCell(theme: Theme, usage: WindowUsage, width: number): string {
  const limited = usage.tokenLimit !== undefined || usage.requestLimit !== undefined;
  if (!limited) {
    return `${bar(theme, 0, width, false)} ${theme.dim(formatTokens(usage.tokens))}`;
  }
  return `${bar(theme, usage.utilization, width)} ${levelStyle(
    theme,
    usage.utilization,
  )(percent(usage.utilization))}`;
}

export function renderAccounts(theme: Theme, rows: AccountRow[], columns: number): string[] {
  const barWidth = columns >= 110 ? 10 : columns >= 90 ? 8 : 5;
  const cols: Column[] = [
    { header: 'ACCOUNT' },
    { header: 'ID', drop: 4 },
    { header: 'PROVIDER', drop: 2 },
    { header: 'STATUS' },
    { header: 'PRI', align: 'right', drop: 5 },
    { header: '1M', drop: 3 },
    { header: '5H' },
    { header: '24H', drop: 1 },
  ];
  const body = rows.map(({ account, usage }) => [
    truncate(account.label, 28),
    theme.dim(account.id),
    account.provider,
    statusLabel(theme, account),
    String(account.priority),
    windowCell(theme, usage.windows['1m'], barWidth),
    windowCell(theme, usage.windows['5h'], barWidth),
    windowCell(theme, usage.windows['24h'], barWidth),
  ]);
  return table(theme, cols, body, columns);
}

export function renderStatus(theme: Theme, report: StatusReport, columns = 100): string[] {
  const lines: string[] = [];
  const name = theme.bold(theme.accent('DaveCode'));
  if (report.running) {
    const meta = [
      report.version ? `v${report.version}` : undefined,
      report.uptimeSec !== undefined ? `up ${formatDuration(report.uptimeSec)}` : undefined,
    ].filter(Boolean);
    lines.push(
      `${name}  ${theme.ok(`${theme.glyph.dot} running`)}  ${theme.accent(report.url)}  ${theme.dim(meta.join(' · '))}`,
    );
  } else {
    lines.push(
      `${name}  ${theme.dim(`${theme.glyph.pending} not running`)}  ${theme.dim(`local state from ${report.home}`)}`,
    );
  }
  if (report.runner && report.runner.state !== 'idle') {
    lines.push(
      `${theme.dim('runner')}  ${report.runner.state}${report.runner.taskId ? theme.dim(` · ${report.runner.taskId}`) : ''}`,
    );
  }
  lines.push('');

  if (report.accounts.length === 0) {
    lines.push(theme.dim('No accounts yet.'));
    lines.push(`Add one with ${theme.accent('davecode accounts add')}.`);
  } else {
    lines.push(...renderAccounts(theme, report.accounts, columns));
    const troubled = report.accounts.filter(
      ({ account }) => account.lastError && account.status !== 'active',
    );
    if (troubled.length > 0) lines.push('');
    for (const { account } of troubled) {
      lines.push(
        `${theme.warn(theme.glyph.warn)} ${account.label}: ${theme.dim(truncate(account.lastError ?? '', Math.max(20, columns - account.label.length - 4)))}`,
      );
    }
  }

  const flags = Object.entries(report.experimental)
    .filter(([, on]) => on)
    .map(([flag]) => `experimental.${flag}`);
  if (flags.length > 0) {
    lines.push('');
    lines.push(
      theme.warn(`${theme.glyph.warn} ${flags.join(', ')} enabled (may violate provider ToS)`),
    );
  }
  if (!report.running) {
    lines.push('');
    lines.push(theme.dim(`Start the gateway with ${'`davecode start`'} for live data.`));
  }
  return lines;
}

export async function statusCommand(ctx: CliContext): Promise<number> {
  const report = await gatherStatus(ctx);
  if (ctx.json) {
    printJson(ctx, {
      running: report.running,
      source: report.source,
      url: report.url,
      version: report.version ?? null,
      uptimeSec: report.uptimeSec ?? null,
      experimental: report.experimental,
      runner: report.runner ?? null,
      accounts: report.accounts.map(({ account, usage }) => ({ ...account, usage })),
    });
    return EXIT.ok;
  }
  for (const line of renderStatus(ctx.theme, report, ctx.columns)) ctx.out(line);
  return EXIT.ok;
}
