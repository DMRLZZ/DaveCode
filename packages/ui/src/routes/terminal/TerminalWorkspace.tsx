import { lazy, Suspense, useEffect, useState } from 'react';
import { BrandMark } from '../../components/shell/Sidebar';
import { cn } from '../../lib/cn';
import { preferencesBridge, terminalBridge } from '../../lib/desktop';
import { usePreferences } from '../../lib/preferences';
import { Link } from '../../lib/router';

const Panes = lazy(() => import('./Panes').then((m) => ({ default: m.Panes })));
const Onboarding = lazy(() =>
  import('../onboarding/Onboarding').then((m) => ({ default: m.Onboarding })),
);

/** Mounted for the whole session once visited, so agents keep running on other pages. */
export function TerminalWorkspace({ active }: { active: boolean }) {
  const [visited, setVisited] = useState(active);
  const preferences = usePreferences();
  useEffect(() => {
    if (active) setVisited(true);
  }, [active]);
  if (!visited) return null;
  const bridge = terminalBridge();
  // The first-run setup comes before the first terminal, and only in the desktop app.
  const setup = bridge && preferencesBridge() && !preferences.onboarded;
  return (
    <div className={cn('ws-invert fixed inset-0 z-20 bg-black text-zinc-100', !active && 'hidden')}>
      {bridge ? (
        <Suspense fallback={null}>
          {setup ? <Onboarding /> : <Panes bridge={bridge} active={active} />}
        </Suspense>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
          <BrandMark className="size-10" />
          <p className="font-mono text-sm">Terminal panes run in the DaveCode desktop app.</p>
          <Link to="/" className="font-mono text-xs text-zinc-400 underline">
            Back to the workspace
          </Link>
        </div>
      )}
    </div>
  );
}
