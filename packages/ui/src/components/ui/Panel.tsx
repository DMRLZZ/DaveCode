import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export function Panel({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn('flex min-w-0 flex-col rounded-lg border border-line bg-panel', className)}
      {...rest}
    />
  );
}

export function PanelHeader({
  title,
  id,
  meta,
  actions,
  className,
}: {
  title: ReactNode;
  id?: string;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3.5 py-2',
        className,
      )}
    >
      <h2 id={id} className="text-[13px] font-medium text-fg">
        {title}
      </h2>
      {meta && <div className="text-[12px] text-muted">{meta}</div>}
      {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
    </header>
  );
}

/** Page heading row shared by every screen. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-3 pb-4">
      <div className="min-w-0">
        <h1 className="text-[17px] font-semibold tracking-tight text-fg">{title}</h1>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      </div>
      {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
