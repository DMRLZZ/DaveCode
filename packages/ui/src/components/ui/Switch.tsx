import { cn } from '../../lib/cn';

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name; rendered visually hidden. */
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={cn(
        'relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border transition-colors duration-150 ease-snappy',
        checked ? 'border-accent bg-accent' : 'border-line-strong bg-track',
        'disabled:cursor-not-allowed disabled:opacity-45',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'inline-block size-3 rounded-full shadow-sm transition-transform duration-150 ease-snappy',
          checked ? 'translate-x-[15px] bg-accent-fg' : 'translate-x-[2px] bg-fg-2',
        )}
      />
    </button>
  );
}
