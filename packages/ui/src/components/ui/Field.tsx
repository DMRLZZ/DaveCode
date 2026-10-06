import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  useId,
} from 'react';
import { cn } from '../../lib/cn';

const control =
  'h-8 w-full min-w-0 rounded-md border border-line-strong bg-bg px-2.5 text-[13px] text-fg placeholder:text-faint transition-[border-color,box-shadow] duration-150 ease-snappy hover:border-faint/70 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:opacity-50 aria-invalid:border-err';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn(control, className)} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select ref={ref} className={cn(control, 'cursor-pointer pr-7', className)} {...rest}>
        {children}
      </select>
    );
  },
);

/**
 * Label + control + helper/error text. The render prop receives the ids to wire up
 * `id`, `aria-describedby` and `aria-invalid` on the control.
 */
export function Field({
  label,
  hint,
  error,
  required,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  className?: string;
  children: (ids: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-[12px] font-medium text-fg-2">
        {label}
        {required && (
          <span aria-hidden className="ml-0.5 text-accent-text">
            *
          </span>
        )}
      </label>
      {children({ id, describedBy: describedBy || undefined, invalid: Boolean(error) })}
      {hint && !error && (
        <p id={hintId} className="text-[12px] leading-4 text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-[12px] leading-4 text-err">
          {error}
        </p>
      )}
    </div>
  );
}
