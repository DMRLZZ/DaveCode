import { lazy, Suspense, useEffect, useState } from 'react';
import { BrandMark } from '../../components/shell/Sidebar';
import { cn } from '../../lib/cn';
import { terminalBridge } from '../../lib/desktop';
import { Link } from '../../lib/router';

const Panes = lazy(() => import('./Panes').then((m) => ({ default: m.Panes })));

/** Mounted for the whole session once visited, so agents keep running on other pages. */
export function TerminalWorkspace({ active }: { active: boolean }) {
  const [visited, setVisited] = useState(active);
  useEffect(() => {
    if (active) setVisited(true);
  }, [active]);
  if (!visited) return null;
  const bridge = terminalBridge();
  return (
    <div className={cn('fixed inset-0 z-20 bg-black text-zinc-100', !active && 'hidden')}>
      {bridge ? (
        <Suspense fallback={null}>
          <Panes bridge={bridge} active={active} />
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
