import { AlertTriangle, Info, OctagonAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

type CalloutTone = 'info' | 'warn' | 'err';

const styles: Record<CalloutTone, { box: string; icon: typeof Info }> = {
  info: { box: 'border-info/25 bg-info-soft [&_svg]:text-info', icon: Info },
  warn: { box: 'border-warn/30 bg-warn-soft [&_svg]:text-warn', icon: AlertTriangle },
  err: { box: 'border-err/30 bg-err-soft [&_svg]:text-err', icon: OctagonAlert },
};

export function Callout({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: CalloutTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const { box, icon: Icon } = styles[tone];
  return (
    <div
      role={tone === 'info' ? 'note' : 'alert'}
      className={cn(
        'flex gap-2.5 rounded-md border px-3 py-2.5 text-[12px] leading-5',
        box,
        className,
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
      <div className="min-w-0 flex-1 text-fg-2">
        {title && <p className="font-medium text-fg">{title}</p>}
        {children}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}
