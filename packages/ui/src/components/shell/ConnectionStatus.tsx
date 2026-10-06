import { FlaskConical, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { useData } from '../../lib/data';
import { formatRelative } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import { navigate } from '../../lib/router';
import { useSettings } from '../../lib/settings';
import { Dot, type Tone } from '../ui/Badge';
import { Button } from '../ui/Button';
import { CommandHint } from '../ui/CopyButton';

/** Connection pill in the top bar, with a details popover (source, stream state, retry). */
export function ConnectionStatus() {
  const { connection, retry } = useData();
  const settings = useSettings();
  const now = useNow(1000);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const { mode, stream, reason, unauthorized } = connection;
  let tone: Tone = 'neutral';
  let label = 'Connecting…';
  let pulse = false;
  if (mode === 'mock') {
    tone = 'accent';
    label = 'Mock data';
  } else if (unauthorized) {
    tone = 'err';
    label = 'Unauthorized';
  } else if (mode === 'live' && stream.state === 'open') {
    tone = 'ok';
    label = 'Live';
    pulse = true;
  } else if (stream.state === 'reconnecting') {
    tone = 'warn';
    const secs = stream.retryAt ? Math.max(0, Math.ceil((stream.retryAt - now) / 1000)) : 0;
    label = secs > 0 ? `Reconnecting in ${secs}s` : 'Reconnecting…';
  }

  const gateway = settings.gatewayUrl || window.location.origin;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Connection: ${label}. Show details`}
        className={cn(
          'flex h-7 items-center gap-2 rounded-md border px-2.5 text-[12px] font-medium transition-colors duration-150',
          mode === 'mock'
            ? 'border-accent/30 bg-accent-soft text-accent-text hover:border-accent/50'
            : 'border-line bg-panel text-fg-2 hover:border-line-strong hover:text-fg',
        )}
      >
        {mode === 'mock' ? (
          <FlaskConical aria-hidden className="size-3.5" strokeWidth={1.75} />
        ) : (
          <Dot tone={tone} pulse={pulse} className="size-[7px]" />
        )}
        <span className="whitespace-nowrap">{label}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Connection details"
          className="absolute top-9 right-0 z-30 w-[320px] animate-pop-in rounded-lg border border-line-strong bg-panel p-3.5 text-[12px] shadow-overlay"
        >
          <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5">
            <dt className="text-muted">Source</dt>
            <dd className="text-fg">
              {mode === 'mock'
                ? 'Simulated in this browser'
                : mode === 'probing'
                  ? 'Probing…'
                  : 'Gateway'}
            </dd>
            <dt className="text-muted">Gateway</dt>
            <dd className="truncate font-mono text-fg-2">{gateway}</dd>
            <dt className="text-muted">Event stream</dt>
            <dd className="text-fg-2">
              {stream.state}
              {stream.attempt > 0 && ` · attempt ${stream.attempt}`}
            </dd>
            {stream.lastEventAt && (
              <>
                <dt className="text-muted">Last event</dt>
                <dd className="text-fg-2">{formatRelative(stream.lastEventAt, now)}</dd>
              </>
            )}
          </dl>
          {mode === 'mock' && (
            <div className="mt-3 border-t border-line pt-3 text-fg-2">
              {reason === 'unreachable' && (
                <>
                  <p>
                    The gateway did not answer, so the dashboard is showing simulated data. Start it
                    with:
                  </p>
                  <CommandHint command="davecode start" className="mt-2" />
                  <p className="mt-2 text-muted">Retrying automatically every 15 s.</p>
                </>
              )}
              {reason === 'forced' && (
                <p>
                  Mock mode is forced by <code className="font-mono">?mock=1</code> or{' '}
                  <code className="font-mono">VITE_DAVECODE_MOCK=1</code>.
                </p>
              )}
              {reason === 'setting' && <p>Mock mode is selected in Settings.</p>}
            </div>
          )}
          {unauthorized && (
            <p className="mt-3 border-t border-line pt-3 text-err">
              The gateway requires a bearer token. Add it in Settings.
            </p>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setOpen(false);
                navigate('/settings');
              }}
            >
              Settings
            </Button>
            {reason !== 'forced' && (
              <Button size="sm" icon={RefreshCw} onClick={retry}>
                Retry now
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
