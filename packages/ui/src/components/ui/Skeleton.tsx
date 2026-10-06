import { cn } from '../../lib/cn';

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('skeleton h-3', className)} />;
}

/** A stack of skeleton rows for tables and lists. */
export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col', className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
          key={i}
          className="flex items-center gap-3 border-b border-line px-3.5 py-3 last:border-b-0"
        >
          <Skeleton className="size-5 rounded" />
          <Skeleton className="h-3 w-40" />
          <Skeleton className="ml-auto h-3 w-24" />
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}
