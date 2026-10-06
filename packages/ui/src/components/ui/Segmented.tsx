import type { LucideIcon } from 'lucide-react';
import { useId } from 'react';
import { cn } from '../../lib/cn';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  count?: number;
}

/**
 * Segmented control built on native radio inputs: arrow-key navigation, form semantics and
 * screen-reader announcements come for free.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = 'md',
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentOption<T>[];
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const name = useId();
  return (
    <fieldset
      className={cn(
        'inline-flex w-fit items-center gap-0.5 rounded-md border border-line bg-bg p-0.5',
        className,
      )}
    >
      <legend className="sr-only">{label}</legend>
      {options.map((opt) => {
        const active = opt.value === value;
        const Icon = opt.icon;
        return (
          <label
            key={opt.value}
            className={cn(
              'relative inline-flex cursor-pointer items-center gap-1.5 rounded-[5px] font-medium whitespace-nowrap transition-colors duration-150 ease-snappy',
              'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-1 has-[:focus-visible]:outline-accent',
              size === 'sm' ? 'h-6 px-2 text-[12px]' : 'h-7 px-2.5 text-[12px]',
              active
                ? 'bg-active text-fg shadow-[inset_0_0_0_1px_var(--dc-line-strong)]'
                : 'text-muted hover:text-fg',
            )}
          >
            <input
              type="radio"
              name={name}
              value={opt.value}
              checked={active}
              onChange={() => onChange(opt.value)}
              className="sr-only"
            />
            {Icon && <Icon aria-hidden className="size-3.5" strokeWidth={1.75} />}
            {opt.label}
            {opt.count !== undefined && (
              <span className={cn('tnum font-mono text-2xs', active ? 'text-fg-2' : 'text-faint')}>
                {opt.count}
              </span>
            )}
          </label>
        );
      })}
    </fieldset>
  );
}
