import { cn } from '../../lib/cn';
import { formatCompact, formatPercent } from '../../lib/format';
import type { WindowUsage } from '../../lib/types';

export const BACKPRESSURE = 0.85;
export const SHIFT = 0.9;

export function severity(u: number): 'normal' | 'warn' | 'critical' {
  if (u >= SHIFT) return 'critical';
  if (u >= BACKPRESSURE) return 'warn';
  return 'normal';
}

function describe(w: WindowUsage): string {
  const parts = [`${formatCompact(w.tokens)} tokens`];
  if (w.tokenLimit) parts[0] += ` of ${formatCompact(w.tokenLimit)}`;
  parts.push(
    `${formatCompact(w.requests)} requests${w.requestLimit ? ` of ${formatCompact(w.requestLimit)}` : ''}`,
  );
  return parts.join(' · ');
}

/**
 * Quota utilization meter. The fill carries severity (neutral → warning at the 85 %
 * backpressure threshold → critical at the 90 % shift threshold); tick marks show both
 * thresholds so the reader sees how close an account is to being throttled.
 */
export function QuotaMeter({
  usage,
  label,
  compact,
  className,
}: {
  usage: WindowUsage | undefined;
  label: string;
  compact?: boolean;
  className?: string;
}) {
  const limited = Boolean(usage && (usage.tokenLimit || usage.requestLimit));
  const u = usage?.utilization ?? 0;
  const sev = severity(u);
  const fill = sev === 'critical' ? 'bg-err' : sev === 'warn' ? 'bg-warn' : 'bg-meter';
  const valueText = limited ? `${formatPercent(u)} of the ${label} window` : `No ${label} limit`;

  return (
    <div
      className={cn('flex min-w-0 items-center gap-2', className)}
      title={usage ? describe(usage) : undefined}
    >
      {!compact && <span className="w-7 shrink-0 font-mono text-2xs text-muted">{label}</span>}
      {/* biome-ignore lint/a11y/useSemanticElements: native <meter> cannot draw the threshold ticks */}
      <div
        role="meter"
        aria-label={`${label} quota`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={limited ? Math.round(Math.min(u, 1) * 100) : 0}
        aria-valuetext={valueText}
        className="relative h-1.5 min-w-10 flex-1 rounded-full bg-track"
      >
        {limited && (
          <div
            className={cn(
              'absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-snappy',
              fill,
            )}
            style={{ width: `${Math.min(100, u * 100)}%` }}
          />
        )}
        {limited && (
          <>
            <span
              aria-hidden
              className="absolute -top-0.5 -bottom-0.5 w-px bg-warn/70"
              style={{ left: `${BACKPRESSURE * 100}%` }}
            />
            <span
              aria-hidden
              className="absolute -top-0.5 -bottom-0.5 w-px bg-err/80"
              style={{ left: `${SHIFT * 100}%` }}
            />
          </>
        )}
      </div>
      <span
        className={cn(
          'tnum w-9 shrink-0 text-right font-mono text-2xs',
          !limited
            ? 'text-faint'
            : sev === 'critical'
              ? 'text-err'
              : sev === 'warn'
                ? 'text-warn'
                : 'text-fg-2',
        )}
      >
        {limited ? formatPercent(u) : '—'}
      </span>
    </div>
  );
}

/** Legend explaining the two threshold ticks. */
export function QuotaLegend({ className }: { className?: string }) {
  return (
    <div
      className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted', className)}
    >
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="h-2.5 w-px bg-warn" />
        85% backpressure
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="h-2.5 w-px bg-err" />
        90% traffic shift
      </span>
    </div>
  );
}
