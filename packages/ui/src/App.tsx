import { type ComponentType, lazy, Suspense, useEffect, useRef } from 'react';
import { CommandPalette } from './components/shell/CommandPalette';
import { ConnectionStatus } from './components/shell/ConnectionStatus';
import { ShortcutsDialog } from './components/shell/ShortcutsDialog';
import { Sidebar } from './components/shell/Sidebar';
import { Toaster } from './components/shell/Toaster';
import { TopBar } from './components/shell/TopBar';
import { Skeleton } from './components/ui/Skeleton';
import { useMediaQuery } from './lib/hooks';
import type { PageId } from './lib/nav';
import { pageForPath } from './lib/nav';
import { useHealth } from './lib/queries';
import { useLocation } from './lib/router';
import { applyTheme, updateSettings, useSettings } from './lib/settings';
import { useGlobalShortcuts } from './lib/shortcuts';
import { NARROW_QUERY, toggleSidebar, ui, useUi } from './lib/ui-state';
import { NotFound } from './routes/NotFound';
import { Overview } from './routes/Overview';

// The overview ships in the main chunk; other screens load on first visit.
const PAGES: Record<PageId, ComponentType> = {
  overview: Overview,
  accounts: lazy(() => import('./routes/accounts/Accounts').then((m) => ({ default: m.Accounts }))),
  traffic: lazy(() => import('./routes/traffic/Traffic').then((m) => ({ default: m.Traffic }))),
  routes: lazy(() => import('./routes/RoutesPage').then((m) => ({ default: m.RoutesPage }))),
  tasks: lazy(() => import('./routes/tasks/Tasks').then((m) => ({ default: m.Tasks }))),
  runner: lazy(() => import('./routes/runner/Runner').then((m) => ({ default: m.Runner }))),
  settings: lazy(() => import('./routes/Settings').then((m) => ({ default: m.Settings }))),
};

function PageFallback() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-label="Loading page">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-4 w-80" />
      <Skeleton className="mt-4 h-64 w-full rounded-lg" />
    </div>
  );
}

export function App() {
  const settings = useSettings();
  const { path } = useLocation();
  const page = pageForPath(path);
  const narrow = useMediaQuery(NARROW_QUERY);
  const { sidebarOverlay } = useUi();
  const overlay = narrow && sidebarOverlay;
  const collapsed = narrow ? !sidebarOverlay : settings.sidebarCollapsed;
  const mainRef = useRef<HTMLElement>(null);
  const health = useHealth();
  useGlobalShortcuts();

  useEffect(() => applyTheme(settings.theme), [settings.theme]);

  // Move focus to the main region on navigation so screen readers announce the new page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on route change only
  useEffect(() => {
    ui.setSidebarOverlay(false);
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
    document.title = page ? `${page.label} · DaveCode` : 'DaveCode';
  }, [path]);

  return (
    <div className="flex min-h-dvh">
      {/* A button rather than an anchor: `#main` would be read as a route by the hash router. */}
      <button
        type="button"
        onClick={() => mainRef.current?.focus()}
        className="sr-only z-50 rounded-md bg-accent px-3 py-2 text-accent-fg focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </button>
      <Sidebar
        activeId={page?.id}
        collapsed={collapsed}
        overlay={overlay}
        version={health.data?.version}
        onToggle={() =>
          toggleSidebar(() => updateSettings({ sidebarCollapsed: !settings.sidebarCollapsed }))
        }
      />
      {overlay && (
        <button
          type="button"
          aria-label="Close sidebar"
          onClick={() => ui.setSidebarOverlay(false)}
          className="fixed inset-0 z-30 bg-scrim animate-fade-in"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          title={page?.label ?? 'Not found'}
          status={<ConnectionStatus />}
          onOpenPalette={ui.openPalette}
          onOpenHelp={ui.openHelp}
        />
        <main
          id="main"
          ref={mainRef}
          tabIndex={-1}
          className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-5 outline-none md:px-6"
        >
          {page ? <Page id={page.id} /> : <NotFound />}
        </main>
      </div>
      <CommandPalette />
      <ShortcutsDialog />
      <Toaster />
    </div>
  );
}

function Page({ id }: { id: PageId }) {
  const Component = PAGES[id];
  return (
    <Suspense fallback={<PageFallback />}>
      <Component />
    </Suspense>
  );
}
