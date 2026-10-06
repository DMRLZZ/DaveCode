import type { LucideIcon } from 'lucide-react';
import { type ButtonHTMLAttributes, forwardRef } from 'react';
import { cn } from '../../lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: LucideIcon;
  /** Render a square icon-only button. Requires `aria-label`. */
  iconOnly?: boolean;
  loading?: boolean;
}

const variants: Record<Variant, string> = {
  primary:
    'bg-accent text-accent-fg hover:brightness-110 active:brightness-95 border border-transparent font-medium',
  secondary: 'bg-raised text-fg border border-line-strong hover:bg-hover hover:border-faint/60',
  ghost: 'text-fg-2 border border-transparent hover:bg-hover hover:text-fg',
  danger: 'bg-err-soft text-err border border-err/30 hover:bg-err/20',
};

const sizes: Record<Size, string> = {
  sm: 'h-7 gap-1.5 px-2.5 text-[12px]',
  md: 'h-8 gap-2 px-3 text-[13px]',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon: Icon,
    iconOnly,
    loading,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md whitespace-nowrap select-none',
        'transition-[background-color,border-color,color,filter,transform] duration-150 ease-snappy',
        'active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45',
        variants[variant],
        sizes[size],
        iconOnly && (size === 'sm' ? 'w-7 px-0' : 'w-8 px-0'),
        className,
      )}
      {...rest}
    >
      {loading ? (
        <span
          aria-hidden
          className="size-3.5 animate-spin rounded-full border-[1.5px] border-current border-r-transparent"
        />
      ) : Icon ? (
        <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
      ) : null}
      {!iconOnly && children}
    </button>
  );
});
