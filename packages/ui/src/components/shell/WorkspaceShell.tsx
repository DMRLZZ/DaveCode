import { BookOpen, Menu, Plus, Settings, SlidersHorizontal } from 'lucide-react';
import { type ReactNode, type RefObject, useState } from 'react';
import { useData } from '../../lib/data';
import { useGoals } from '../../lib/queries';
import { Link, useLocation } from '../../lib/router';
import { SessionButton } from '../auth/AuthGate';
import { Button } from '../ui/Button';
import { BrandMark } from './Sidebar';

export function WorkspaceShell({
  children,
  mainRef,
}: {
  children: ReactNode;
  mainRef: RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const { params, path } = useLocation();
  const goals = useGoals();
  const { connection } = useData();
  return (
    <div className="flex min-h-dvh bg-bg">
      <button
        type="button"
        onClick={() => mainRef.current?.focus()}
        className="sr-only z-50 bg-accent px-3 py-2 text-accent-fg focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </button>
      <aside
        className={`${open ? 'fixed inset-y-0 left-0 z-40 flex shadow-overlay' : 'hidden'} w-60 shrink-0 flex-col border-r border-line bg-panel p-3 md:sticky md:top-0 md:flex md:h-dvh`}
        aria-label="Workspace navigation"
      >
        <Link
          to="/"
          className="mb-8 flex items-center gap-2.5 px-2 py-3 text-[15px] font-semibold tracking-tight"
        >
          <BrandMark className="size-7" />
          DaveCode
        </Link>
        <Link
          to="/?new=1"
          onClick={() => setOpen(false)}
          className="mb-2 flex h-10 items-center gap-2 rounded-lg border border-line-strong px-3 text-[13px] text-fg transition-colors hover:bg-hover"
        >
          <Plus aria-hidden className="size-4" />
          New task
        </Link>
        <Link
          to="/library"
          onClick={() => setOpen(false)}
          aria-current={path === '/library' ? 'page' : undefined}
          className="mb-7 flex h-10 items-center gap-2 rounded-lg px-3 text-[13px] text-fg-2 hover:bg-hover"
        >
          <BookOpen aria-hidden className="size-4" />
          Creative library
        </Link>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <p className="mb-2 px-3 text-[12px] text-muted">Recent work</p>
          <nav aria-label="Recent work" className="flex flex-col gap-1">
            {(goals.data ?? []).slice(0, 20).map((goal) => (
              <Link
                key={goal.id}
                to={`/?goal=${encodeURIComponent(goal.id)}`}
                onClick={() => setOpen(false)}
                aria-current={params.get('goal') === goal.id ? 'page' : undefined}
                className="truncate rounded-lg px-3 py-2.5 text-[13px] text-fg-2 transition-colors hover:bg-hover aria-[current=page]:bg-active aria-[current=page]:text-fg"
              >
                {goal.objective}
              </Link>
            ))}
            {goals.data?.length === 0 && (
              <p className="px-3 py-2 text-[12px] leading-5 text-muted">
                Your first task starts here.
              </p>
            )}
          </nav>
        </div>
        <div className="mt-4 flex flex-col gap-1 border-t border-line pt-3">
          <Link
            to="/accounts"
            className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-[13px] text-fg-2 hover:bg-hover"
          >
            <SlidersHorizontal aria-hidden className="size-4" />
            AI connections
          </Link>
          <Link
            to="/settings"
            className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-[13px] text-fg-2 hover:bg-hover"
          >
            <Settings aria-hidden className="size-4" />
            Settings
          </Link>
        </div>
      </aside>
      {open && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-30 bg-scrim md:hidden"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center justify-between gap-3 px-5 md:px-8">
          <div className="flex items-center gap-2">
            <Button
              icon={Menu}
              iconOnly
              aria-label="Open navigation"
              variant="ghost"
              className="md:hidden"
              onClick={() => setOpen(true)}
            />
            <span className="text-[14px] text-fg-2">
              {path === '/library' ? 'Creative library' : 'Workspace'}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-[12px] text-muted">
              {connection.mode === 'mock'
                ? 'Demo'
                : connection.mode === 'probing'
                  ? 'Connecting'
                  : 'On your device'}
            </span>
            <SessionButton />
          </div>
        </header>
        <main
          ref={mainRef}
          tabIndex={-1}
          id="main"
          className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-5 pb-6 md:px-10"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
