import { emptyUsage, renderAccounts } from '../commands/status';
import { formatTaskTree, summaryLine } from '../lib/task-tree';
import { padEnd } from '../ui/format';
import type { Theme } from '../ui/theme';
import type { ChatBackend } from './backend';
import { KEY_HINTS, SLASH_COMMANDS } from './slash';

/** Text produced by the informational slash commands (ANSI-styled, rendered as-is by Ink). */

export function helpText(theme: Theme): string {
  const width = Math.max(...SLASH_COMMANDS.map((c) => c.name.length + (c.args?.length ?? 0))) + 4;
  const commands = SLASH_COMMANDS.map(
    (c) =>
      `${theme.accent(padEnd(`/${c.name}${c.args ? ` ${c.args}` : ''}`, width))}${theme.dim(c.description)}`,
  );
  const keyWidth = Math.max(...KEY_HINTS.map(([k]) => k.length)) + 2;
  const keys = KEY_HINTS.map(([k, v]) => `${padEnd(k, keyWidth)}${theme.dim(v)}`);
  return [theme.bold('Commands'), ...commands, '', theme.bold('Keys'), ...keys].join('\n');
}

export async function modelsText(theme: Theme, backend: ChatBackend, current: string) {
  const models = await backend.models();
  const ids = models
    .map((m) => m.id)
    .sort((a, b) => {
      const da = a.startsWith('davecode/') ? 0 : 1;
      const db = b.startsWith('davecode/') ? 0 : 1;
      return da - db || a.localeCompare(b);
    });
  if (ids.length === 0)
    return theme.dim('No models yet. Add an account with `davecode accounts add`.');
  const shown = ids.slice(0, 40);
  const lines = shown.map((id) =>
    id === current ? `${theme.accent(theme.glyph.dot)} ${theme.accent(id)}` : `  ${id}`,
  );
  if (ids.length > shown.length) lines.push(theme.dim(`  … and ${ids.length - shown.length} more`));
  lines.push('', theme.dim('Switch with /model <id>'));
  return lines.join('\n');
}

export async function routesText(theme: Theme, backend: ChatBackend) {
  const { defaultRoute, routes } = await backend.routes();
  if (routes.length === 0) {
    return [
      `${theme.dim('No routes configured.')} davecode/${defaultRoute} uses every account with a default model.`,
      theme.dim('Define routes under routing.routes in ~/.davecode/config.json.'),
    ].join('\n');
  }
  const lines: string[] = [];
  for (const route of routes) {
    const mark = route.name === defaultRoute ? theme.dim(' (default)') : '';
    lines.push(
      `${theme.accent(`davecode/${route.name}`)}${mark}${route.description ? theme.dim(`  ${route.description}`) : ''}`,
    );
    route.targets.forEach((t, i) => {
      lines.push(
        `  ${theme.dim(`${i + 1}.`)} ${t.provider}/${t.model}${t.accountId ? theme.dim(` @${t.accountId}`) : ''}`,
      );
    });
  }
  return lines.join('\n');
}

export async function accountsText(theme: Theme, backend: ChatBackend, columns: number) {
  const [accounts, usage] = await Promise.all([backend.accounts(), backend.usage()]);
  if (accounts.length === 0)
    return theme.dim('No accounts yet. Add one with `davecode accounts add`.');
  const byId = new Map(usage.map((u) => [u.accountId, u]));
  return renderAccounts(
    theme,
    accounts.map((account) => ({ account, usage: byId.get(account.id) ?? emptyUsage(account.id) })),
    columns,
  ).join('\n');
}

export async function tasksText(theme: Theme, backend: ChatBackend, columns: number) {
  const { project, graph } = await backend.tasks();
  if (!project)
    return theme.dim('No project brain is being served. Start DaveCode inside a repository.');
  if (graph.tasks.length === 0) {
    return theme.dim(`${project.name}: no tasks yet. Add one with \`davecode tasks add\`.`);
  }
  return [
    `${theme.bold(project.name)}  ${summaryLine(theme, graph)}`,
    '',
    ...formatTaskTree(theme, graph, { width: columns }),
  ].join('\n');
}

export async function statusText(theme: Theme, backend: ChatBackend, model: string) {
  const health = await backend.health();
  if (!health) return theme.error('DaveCode is not answering. Restart it with davecode.');
  const [accounts, runner] = await Promise.all([
    backend.accounts(),
    backend.runner().catch(() => undefined),
  ]);
  const state = (status: string) =>
    status === 'error'
      ? theme.error('needs sign-in · /connect')
      : status === 'cooldown'
        ? theme.warn('cooling down')
        : status === 'disabled'
          ? theme.dim('off')
          : theme.ok('ready');
  const lines = [`${theme.dim('model ')}  ${model}`];
  if (accounts.length === 0) lines.push(`${theme.dim('agents')}  none yet · /connect`);
  for (const [i, account] of accounts.entries()) {
    lines.push(
      `${theme.dim(i === 0 ? 'agents' : '      ')}  ${account.label}  ${state(account.status)}`,
    );
  }
  lines.push(`${theme.dim('runner')}  ${runner ? runner.state : 'unknown'}`);
  return lines.join('\n');
}
