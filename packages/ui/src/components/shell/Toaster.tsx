import { CircleCheck, CircleX, Info, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { dismissToast, useToasts } from '../../lib/toast';

const icons = { ok: CircleCheck, err: CircleX, info: Info };
const tones = { ok: 'text-ok', err: 'text-err', info: 'text-info' };

export function Toaster() {
  const items = useToasts();
  return (
    <section
      aria-live="polite"
      aria-label="Notifications"
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2"
    >
      {items.map((t) => {
        const Icon = icons[t.tone];
        return (
          <div
            key={t.id}
            className="pointer-events-auto flex animate-pop-in gap-2.5 rounded-lg border border-line-strong bg-panel px-3 py-2.5 shadow-overlay"
          >
            <Icon
              aria-hidden
              className={cn('mt-0.5 size-4 shrink-0', tones[t.tone])}
              strokeWidth={1.75}
            />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-fg">{t.title}</p>
              {t.description && <p className="mt-0.5 text-[12px] text-muted">{t.description}</p>}
            </div>
            <button
              type="button"
              onClick={() => dismissToast(t.id)}
              aria-label="Dismiss notification"
              className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg"
            >
              <X aria-hidden className="size-3.5" strokeWidth={1.75} />
            </button>
          </div>
        );
      })}
    </section>
  );
}
