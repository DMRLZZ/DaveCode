import type { Account, DaveConfig, DaveEvent } from '@davecode/core';
import { formatTokens } from '../ui/format';
import type { Theme } from '../ui/theme';

/** One-line accounts summary, e.g. `3 enabled of 4 · anthropic 1 · claude-cli 2`. */
export function summarizeAccounts(accounts: Account[]): string {
  if (accounts.length === 0) return 'none';
  const enabled = accounts.filter((a) => a.enabled);
  const byProvider = new Map<string, number>();
  for (const account of enabled) {
    byProvider.set(account.provider, (byProvider.get(account.provider) ?? 0) + 1);
  }
  const parts = [...byProvider.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, n]) => `${provider} ${n}`);
  const head =
    enabled.length === accounts.length
      ? `${accounts.length} enabled`
      : `${enabled.length} enabled of ${accounts.length}`;
  const problems = accounts.filter((a) => a.status === 'error' || a.status === 'cooldown').length;
  return [head, ...parts, ...(problems > 0 ? [`${problems} need attention`] : [])].join(' · ');
}

/** Warnings for Terms-of-Service-sensitive flags and risky bindings. */
export function runtimeWarnings(config: DaveConfig, host: string): string[] {
  const warnings: string[] = [];
  if (config.experimental.geminiWeb) {
    warnings.push(
      'experimental.geminiWeb is ON: automating the Gemini web app may violate Google’s Terms of Service.',
    );
  }
  if (config.experimental.multiAccountRotation) {
    warnings.push(
      'experimental.multiAccountRotation is ON: rotating subscription logins may violate provider terms.',
    );
  }
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
  if (!loopback && !config.server.authToken) {
    warnings.push(
      `Listening on ${host} without server.authToken: anyone on your network can use your accounts.`,
    );
  }
  return warnings;
}

function clock(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8);
}

/**
 * Compact activity line for `davecode start`, or `undefined` for events that are not worth a
 * line (quota ticks, request starts). Account ids are shown by label when known.
 */
export function formatEventLine(
  theme: Theme,
  event: DaveEvent,
  labelOf: (accountId: string) => string = (id) => id,
): string | undefined {
  const time = theme.dim(clock(event.ts));
  switch (event.type) {
    case 'request.completed': {
      const tokens = formatTokens(event.promptTokens + event.completionTokens);
      return `${time}  ${theme.ok(theme.glyph.ok)} ${event.model}  ${theme.dim(
        `${labelOf(event.accountId)} · ${tokens} tok · ${event.latencyMs}ms`,
      )}`;
    }
    case 'request.failed':
      return `${time}  ${theme.error(theme.glyph.fail)} ${labelOf(event.accountId)}  ${theme.dim(
        `${event.error.kind}${event.error.status ? ` ${event.error.status}` : ''}: ${event.error.message}`,
      )}`;
    case 'router.failover':
      return `${time}  ${theme.warn(theme.glyph.arrow)} failover ${labelOf(event.fromAccountId)} ${
        theme.glyph.arrow
      } ${event.toAccountId ? labelOf(event.toAccountId) : 'none'}  ${theme.dim(event.reason)}`;
    case 'account.removed':
      return `${time}  ${theme.dim(`account ${event.accountId} removed`)}`;
    case 'runner.status':
      return `${time}  ${theme.accent('runner')} ${event.status.state}${
        event.status.taskId ? theme.dim(` · ${event.status.taskId}`) : ''
      }`;
    case 'runner.log':
      return `${time}  ${theme.dim(`[${event.level}]`)} ${event.message}`;
    case 'log':
      return event.level === 'warn' || event.level === 'error'
        ? `${time}  ${event.level === 'error' ? theme.error(event.level) : theme.warn(event.level)} ${theme.dim(event.scope)} ${event.message}`
        : undefined;
    default:
      return undefined;
  }
}
