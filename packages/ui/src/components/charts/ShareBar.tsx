import { cn } from '../../lib/cn';
import { formatCompact, formatPercent } from '../../lib/format';

/** Fixed categorical order (validated palette); a sixth+ entity folds into "Other". */
export const SLOT_CLASSES = ['bg-s1', 'bg-s2', 'bg-s3', 'bg-s4', 'bg-s5'] as const;
const OTHER = 'bg-faint';

export interface ShareItem {
  id: string;
  label: string;
  value: number;
  /** Stable slot index for this entity (color follows the entity, never its rank). */
  slot: number;
}

/**
 * Part-to-whole bar with 2px surface gaps and a legend that doubles as the table view
 * (every value is readable without hovering).
 */
export function ShareBar({
  items,
  unit,
  className,
}: {
  items: ShareItem[];
  unit: string;
  className?: string;
}) {
  const visible = items.filter((i) => i.slot < SLOT_CLASSES.length);
  const folded = items.filter((i) => i.slot >= SLOT_CLASSES.length);
  const rows = [
    ...visible.map((i) => ({ ...i, color: SLOT_CLASSES[i.slot] ?? OTHER })),
    ...(folded.length
      ? [
          {
            id: 'other',
            label: 'Other',
            value: folded.reduce((s, i) => s + i.value, 0),
            slot: 99,
            color: OTHER,
          },
        ]
      : []),
  ];
  const total = rows.reduce((s, r) => s + r.value, 0);

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-[3px]" aria-hidden>
        {total === 0 ? (
          <div className="h-full flex-1 bg-track" />
        ) : (
          rows
            .filter((r) => r.value > 0)
            .map((r) => (
              <div
                key={r.id}
                title={`${r.label}: ${formatCompact(r.value)} ${unit} (${formatPercent(r.value / total)})`}
                className={cn(
                  'h-full transition-[flex-grow] duration-500 ease-snappy first:rounded-l-[3px] last:rounded-r-[3px]',
                  r.color,
                )}
                style={{ flexGrow: r.value, flexBasis: 0 }}
              />
            ))
        )}
      </div>
      <table className="w-full text-[12px]">
        <caption className="sr-only">Share of {unit} by account</caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Account</th>
            <th scope="col">{unit}</th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-line last:border-b-0">
              <td className="py-1.5">
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden className={cn('size-2 shrink-0 rounded-[2px]', r.color)} />
                  <span className="truncate text-fg-2">{r.label}</span>
                </span>
              </td>
              <td className="tnum py-1.5 text-right font-mono text-fg">{formatCompact(r.value)}</td>
              <td className="tnum w-14 py-1.5 text-right font-mono text-muted">
                {total ? formatPercent(r.value / total) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
