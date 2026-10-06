import { type ComponentType, useEffect, useRef } from 'react';
import { ConnectionStatus } from './components/shell/ConnectionStatus';
import { Sidebar } from './components/shell/Sidebar';
import { Toaster } from './components/shell/Toaster';
import { TopBar } from './components/shell/TopBar';
import { useMediaQuery } from './lib/hooks';
import type { PageId } from './lib/nav';
import { pageForPath } from './lib/nav';
import { useHealth } from './lib/queries';
import { useLocation } from './lib/router';
import { applyTheme, updateSettings, useSettings } from './lib/settings';
import { ui } from './lib/ui-state';
import { Accounts } from './routes/accounts/Accounts';
import { NotFound } from './routes/NotFound';
import { Overview } from './routes/Overview';
import { RoutesPage } from './routes/RoutesPage';
import { Runner } from './routes/runner/Runner';
import { Settings } from './routes/Settings';
import { Tasks } from './routes/tasks/Tasks';
import { Traffic } from './routes/traffic/Traffic';

const PAGES: Record<PageId, ComponentType> = {
  overview: Overview,
  accounts: Accounts,
  traffic: Traffic,
  routes: RoutesPage,
  tasks: Tasks,
  runner: Runner,
  settings: Settings,
};

export function App() {
  const settings = useSettings();
  const { path } = useLocation();
  const page = pageForPath(path);
  const narrow = useMediaQuery('(max-width: 1023px)');
  const collapsed = settings.sidebarCollapsed || narrow;
  const mainRef = useRef<HTMLElement>(null);
  const health = useHealth();

  useEffect(() => applyTheme(settings.theme), [settings.theme]);

  // Move focus to the main region on navigation so screen readers announce the new page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on route change only
  useEffect(() => {
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
        version={health.data?.version}
        onToggle={() => updateSettings({ sidebarCollapsed: !settings.sidebarCollapsed })}
      />
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
      <Toaster />
    </div>
  );
}

function Page({ id }: { id: PageId }) {
  const Component = PAGES[id];
  return <Component />;
}
