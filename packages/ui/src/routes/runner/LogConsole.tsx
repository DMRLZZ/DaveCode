import { ArrowDownToLine, Eraser, Search, WrapText } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { formatClock } from '../../lib/format';
import type { LogLine } from '../../lib/live';
import type { LogLevel } from '../../lib/types';

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

const levelText: Record<LogLevel, string> = {
  debug: 'text-muted',
  info: 'text-info',
  warn: 'text-warn',
  error: 'text-err',
};

function messageTone(line: LogLine): string {
  if (line.level === 'error') return 'text-err';
  if (line.level === 'warn') return 'text-warn';
  if (line.message.startsWith('$ ')) return 'text-fg';
  if (line.message.startsWith('✓')) return 'text-ok';
  if (line.message.startsWith('→')) return 'text-info';
  if (line.level === 'debug') return 'text-muted';
  return 'text-fg-2';
}

/**
 * Terminal-style live log console. Always dark (like a real terminal), level filters,
 * runner/all source toggle, text filter, wrap toggle and autoscroll that pauses when the
 * user scrolls up.
 */
export function LogConsole({
  lines,
  onClear,
  className,
}: {
  lines: LogLine[];
  onClear: () => void;
  className?: string;
}) {
  const [levels, setLevels] = useState<Set<LogLevel>>(() => new Set(['info', 'warn', 'error']));
  const [source, setSource] = useState<'runner' | 'all'>('runner');
  const [query, setQuery] = useState('');
  const [wrap, setWrap] = useState(true);
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const counts = useMemo(() => {
    const c: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const l of lines) if (source === 'all' || l.source === 'runner') c[l.level] += 1;
    return c;
  }, [lines, source]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      lines.filter(
        (l) =>
          levels.has(l.level) &&
          (source === 'all' || l.source === 'runner') &&
          (!q || l.message.toLowerCase().includes(q) || (l.taskId ?? l.scope ?? '').includes(q)),
      ),
    [lines, levels, source, q],
  );

  // Autoscroll after render when following.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever the visible lines change
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [visible, follow]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      setFollow(atBottom);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const toggleLevel = (level: LogLevel) =>
    setLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });

  return (
    <section
      aria-label="Runner log"
      className={cn(
        'term flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-term',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <fieldset className="flex items-center gap-1">
          <legend className="sr-only">Log levels</legend>
          {LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              aria-pressed={levels.has(level)}
              onClick={() => toggleLevel(level)}
              className={cn(
                'inline-flex h-6 items-center gap-1.5 rounded border px-2 font-mono text-2xs uppercase transition-colors duration-150',
                levels.has(level)
                  ? 'border-line-strong bg-hover text-fg'
                  : 'border-transparent text-faint hover:text-muted',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'size-1.5 rounded-full bg-current',
                  levels.has(level) && levelText[level],
                )}
              />
              {level}
              <span className="tnum text-muted">{counts[level]}</span>
            </button>
          ))}
        </fieldset>
        <span aria-hidden className="h-4 w-px bg-line-strong" />
        <fieldset className="flex items-center gap-1">
          <legend className="sr-only">Log source</legend>
          {(['runner', 'all'] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={source === s}
              onClick={() => setSource(s)}
              className={cn(
                'h-6 rounded px-2 text-[12px] transition-colors duration-150',
                source === s ? 'bg-hover text-fg' : 'text-muted hover:text-fg-2',
              )}
            >
              {s === 'runner' ? 'Runner' : 'All logs'}
            </button>
          ))}
        </fieldset>
        <div className="relative ml-auto">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted"
            strokeWidth={1.75}
          />
          <input
            type="search"
            aria-label="Filter log lines"
            placeholder="Filter"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-6 w-40 rounded border border-line-strong bg-transparent pr-2 pl-6 font-mono text-[11px] text-fg placeholder:text-faint focus-visible:border-accent focus-visible:outline-none"
            data-filter-input
          />
        </div>
        <button
          type="button"
          aria-pressed={wrap}
          onClick={() => setWrap((w) => !w)}
          aria-label="Wrap long lines"
          title="Wrap long lines"
          className={cn(
            'inline-flex size-6 items-center justify-center rounded',
            wrap ? 'bg-hover text-fg' : 'text-muted hover:text-fg',
          )}
        >
          <WrapText aria-hidden className="size-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear console"
          title="Clear console"
          className="inline-flex size-6 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg"
        >
          <Eraser aria-hidden className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          role="log"
          aria-live="off"
          aria-label="Log lines"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region must be keyboard-scrollable
          tabIndex={0}
          className="absolute inset-0 overflow-auto py-2 font-mono text-[12px] leading-[1.6]"
        >
          {visible.length === 0 ? (
            <p className="px-3 text-muted">
              {lines.length === 0 ? 'Waiting for runner output…' : 'No lines match the filters.'}
            </p>
          ) : (
            visible.map((l) => (
              <div
                key={l.key}
                className={cn(
                  'flex gap-3 px-3 hover:bg-hover/60',
                  wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre',
                  l.level === 'error' && 'bg-err/[0.06]',
                )}
              >
                <span className="tnum shrink-0 text-faint select-none">
                  {formatClock(l.ts, true)}
                </span>
                <span className={cn('w-10 shrink-0 uppercase select-none', levelText[l.level])}>
                  {l.level}
                </span>
                {source === 'all' && (
                  <span className="w-16 shrink-0 truncate text-muted">
                    {l.source === 'runner' ? 'runner' : l.scope}
                  </span>
                )}
                <span className={cn('min-w-0', messageTone(l))}>{l.message}</span>
              </div>
            ))
          )}
        </div>
        {!follow && (
          <button
            type="button"
            onClick={() => {
              const el = scrollRef.current;
              if (el) el.scrollTop = el.scrollHeight;
              setFollow(true);
            }}
            className="absolute right-4 bottom-3 inline-flex animate-pop-in items-center gap-1.5 rounded-md border border-line-strong bg-raised px-2.5 py-1 text-[12px] text-fg shadow-overlay"
          >
            <ArrowDownToLine aria-hidden className="size-3.5" strokeWidth={1.75} />
            Jump to latest
          </button>
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {follow ? '' : 'Autoscroll paused.'}
      </p>
    </section>
  );
}
