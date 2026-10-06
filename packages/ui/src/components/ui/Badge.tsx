import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'err' | 'info';

const tones: Record<Tone, string> = {
  neutral: 'bg-hover text-fg-2 border-line-strong',
  accent: 'bg-accent-soft text-accent-text border-accent/25',
  ok: 'bg-ok-soft text-ok border-ok/25',
  warn: 'bg-warn-soft text-warn border-warn/25',
  err: 'bg-err-soft text-err border-err/25',
  info: 'bg-info-soft text-info border-info/25',
};

const dots: Record<Tone, string> = {
  neutral: 'bg-muted',
  accent: 'bg-accent',
  ok: 'bg-ok',
  warn: 'bg-warn',
  err: 'bg-err',
  info: 'bg-info',
};

export function Badge({
  tone = 'neutral',
  dot,
  pulse,
  mono,
  className,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  pulse?: boolean;
  mono?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1.5 rounded border px-1.5 text-2xs font-medium whitespace-nowrap',
        mono && 'font-mono',
        tones[tone],
        className,
      )}
    >
      {dot && <Dot tone={tone} pulse={pulse} />}
      {children}
    </span>
  );
}

export function Dot({
  tone = 'neutral',
  pulse,
  className,
}: {
  tone?: Tone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-1.5 shrink-0 rounded-full',
        dots[tone],
        pulse && 'animate-pulse-dot',
        pulse && toneText[tone],
        className,
      )}
    />
  );
}

const toneText: Record<Tone, string> = {
  neutral: 'text-muted/60',
  accent: 'text-accent/60',
  ok: 'text-ok/60',
  warn: 'text-warn/60',
  err: 'text-err/60',
  info: 'text-info/60',
};
