import { X } from 'lucide-react';
import { type MouseEvent, type ReactNode, useEffect, useId, useRef } from 'react';
import { cn } from '../../lib/cn';

/**
 * Modal surfaces built on the native <dialog>: focus trapping, Escape-to-close, an inert
 * background and focus restoration come from the platform.
 */
function useNativeDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const handleCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    dialog.addEventListener('cancel', handleCancel);
    return () => dialog.removeEventListener('cancel', handleCancel);
  }, [onClose]);

  const onBackdropClick = (e: MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return { ref, onBackdropClick };
}

interface OverlayProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/** Right-hand sheet for forms and detail views. */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
  width = 'w-[min(480px,100vw)]',
}: OverlayProps & { width?: string }) {
  const { ref, onBackdropClick } = useNativeDialog(open, onClose);
  const titleId = useId();
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a pointer shortcut; Escape is handled natively
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClick={onBackdropClick}
      className={cn(
        'fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none max-w-none border-l border-line bg-panel p-0 text-fg shadow-overlay',
        'backdrop:bg-scrim open:animate-sheet-in',
        width,
        className,
      )}
    >
      {open && (
        <div className="flex h-full flex-col">
          <header className="flex items-start gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-[15px] font-semibold tracking-tight">
                {title}
              </h2>
              {description && <div className="mt-0.5 text-[12px] text-muted">{description}</div>}
            </div>
            <CloseButton onClose={onClose} />
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && (
            <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
              {footer}
            </footer>
          )}
        </div>
      )}
    </dialog>
  );
}

/** Centered dialog for confirmations and help. */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: OverlayProps) {
  const { ref, onBackdropClick } = useNativeDialog(open, onClose);
  const titleId = useId();
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a pointer shortcut; Escape is handled natively
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClick={onBackdropClick}
      className={cn(
        'm-auto w-[min(520px,calc(100vw-2rem))] rounded-xl border border-line-strong bg-panel p-0 text-fg shadow-overlay',
        'backdrop:bg-scrim open:animate-pop-in',
        className,
      )}
    >
      {open && (
        <>
          <header className="flex items-start gap-3 px-5 pt-4 pb-2">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-[15px] font-semibold tracking-tight">
                {title}
              </h2>
              {description && <div className="mt-1 text-[13px] text-muted">{description}</div>}
            </div>
            <CloseButton onClose={onClose} />
          </header>
          <div className="px-5 pb-4">{children}</div>
          {footer && (
            <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
              {footer}
            </footer>
          )}
        </>
      )}
    </dialog>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close"
      className="-mr-1.5 inline-flex size-7 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-hover hover:text-fg"
    >
      <X aria-hidden className="size-4" strokeWidth={1.75} />
    </button>
  );
}
