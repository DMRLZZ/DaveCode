import { cn } from '../../lib/cn';

export const isMac =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Platform-aware modifier label: ⌘ on macOS, Ctrl elsewhere. */
export const modKey = isMac ? '⌘' : 'Ctrl';

export function Kbd({ children, className }: { children: string; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line-strong bg-raised px-1 font-sans text-2xs leading-none font-medium text-muted',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** A key sequence such as ["g", "o"] rendered as separate caps. */
export function Keys({ keys, className }: { keys: string[]; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {keys.map((k, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: key sequences may repeat a key
        <Kbd key={i}>{k}</Kbd>
      ))}
    </span>
  );
}
