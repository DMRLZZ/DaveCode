import { Command } from 'cmdk';
import {
  BookOpen,
  Copy,
  CornerDownLeft,
  FlaskConical,
  GitBranch,
  Keyboard,
  type LucideIcon,
  Moon,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Route as RouteIcon,
  Search,
  Square,
  Sun,
} from 'lucide-react';
import { type ReactNode, type RefObject, useEffect, useRef } from 'react';
import { errorMessage } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useData } from '../../lib/data';
import { NAV } from '../../lib/nav';
import { useAccounts, useRoutes, useRunnerAction, useTasks } from '../../lib/queries';
import { navigate } from '../../lib/router';
import { getSettings, resolveTheme, updateSettings } from '../../lib/settings';
import { toast } from '../../lib/toast';
import { ui, useUi } from '../../lib/ui-state';
import { ProviderIcon, TaskStatusDot } from '../domain';
import { Kbd, Keys } from '../ui/Kbd';

const REPO = 'https://github.com/DMRLZZ/DaveCode';

/** ⌘K / Ctrl+K palette: jump anywhere, run actions, find accounts, tasks and routes. */
export function CommandPalette() {
  const { palette } = useUi();
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (palette && !d.open) {
      d.showModal();
      inputRef.current?.focus();
    }
    if (!palette && d.open) d.close();
  }, [palette]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      ui.closePalette();
    };
    d.addEventListener('cancel', onCancel);
    return () => d.removeEventListener('cancel', onCancel);
  }, []);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a pointer shortcut; Escape closes natively
    <dialog
      ref={ref}
      aria-label="Command palette"
      onClick={(e) => {
        if (e.target === e.currentTarget) ui.closePalette();
      }}
      className="mx-auto mt-[12vh] w-[min(640px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-line-strong bg-panel p-0 text-fg shadow-overlay outline-none backdrop:bg-scrim open:animate-pop-in"
    >
      {palette && <PaletteBody inputRef={inputRef} />}
    </dialog>
  );
}

function PaletteBody({ inputRef }: { inputRef: RefObject<HTMLInputElement | null> }) {
  const accounts = useAccounts();
  const tasks = useTasks();
  const routes = useRoutes();
  const runner = useRunnerAction();
  const { retry, connection } = useData();

  const close = ui.closePalette;
  const run = (fn: () => void) => () => {
    close();
    fn();
  };

  const runnerAction = (action: 'start' | 'pause' | 'stop') =>
    run(() => {
      runner.mutate(action, {
        onSuccess: (s) => toast({ tone: 'info', title: `Runner ${s.state}` }),
        onError: (err) =>
          toast({
            tone: 'err',
            title: `Could not ${action} the runner`,
            description: errorMessage(err),
          }),
      });
    });

  const copy = (text: string, what: string) =>
    run(() => {
      navigator.clipboard
        .writeText(text)
        .then(() => toast({ tone: 'ok', title: `Copied ${what}`, description: text }))
        .catch(() => toast({ tone: 'err', title: 'Clipboard unavailable' }));
    });

  const theme = resolveTheme(getSettings().theme);
  const base = `${getSettings().gatewayUrl || 'http://127.0.0.1:4040'}/v1`;

  return (
    <Command label="Command palette" loop className="flex max-h-[min(520px,70vh)] flex-col">
      <div className="flex items-center gap-2.5 border-b border-line px-4">
        <Search aria-hidden className="size-4 shrink-0 text-muted" strokeWidth={1.75} />
        <Command.Input
          ref={inputRef}
          placeholder="Search pages, actions, accounts, tasks…"
          className="h-12 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-faint"
        />
        <Kbd>Esc</Kbd>
      </div>
      <Command.List className="min-h-0 flex-1 overflow-y-auto p-1.5 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-muted [&_[cmdk-group-heading]]:uppercase">
        <Command.Empty className="px-3 py-8 text-center text-[13px] text-muted">
          No results.
        </Command.Empty>

        <Command.Group heading="Go to">
          {NAV.map((n) => (
            <Item
              key={n.id}
              value={`go ${n.label}`}
              keywords={[n.description]}
              icon={n.icon}
              onSelect={run(() => navigate(n.path))}
              hint={<Keys keys={['g', n.key]} />}
            >
              {n.label}
              <span className="ml-2 text-muted">{n.description}</span>
            </Item>
          ))}
        </Command.Group>

        <Command.Group heading="Actions">
          <Item value="add account" icon={Plus} onSelect={run(() => navigate('/accounts?new=1'))}>
            Add account
          </Item>
          <Item value="start resume runner" icon={Play} onSelect={runnerAction('start')}>
            Start or resume the runner
          </Item>
          <Item value="pause runner" icon={Pause} onSelect={runnerAction('pause')}>
            Pause the runner
          </Item>
          <Item value="stop runner" icon={Square} onSelect={runnerAction('stop')}>
            Stop the runner
          </Item>
          <Item
            value="toggle theme dark light"
            icon={theme === 'dark' ? Sun : Moon}
            onSelect={run(() => updateSettings({ theme: theme === 'dark' ? 'light' : 'dark' }))}
          >
            Switch to {theme === 'dark' ? 'light' : 'dark'} theme
          </Item>
          <Item
            value="toggle mock data demo"
            icon={FlaskConical}
            onSelect={run(() =>
              updateSettings({ dataMode: connection.mode === 'mock' ? 'auto' : 'mock' }),
            )}
          >
            {connection.mode === 'mock' ? 'Use the live gateway (auto)' : 'Show mock data'}
          </Item>
          <Item value="copy openai base url" icon={Copy} onSelect={copy(base, 'base URL')}>
            Copy OpenAI base URL
            <span className="ml-2 font-mono text-muted">{base}</span>
          </Item>
          <Item value="retry reconnect gateway" icon={RefreshCw} onSelect={run(retry)}>
            Retry gateway connection
          </Item>
          <Item
            value="keyboard shortcuts help"
            icon={Keyboard}
            onSelect={run(ui.openHelp)}
            hint={<Kbd>?</Kbd>}
          >
            Keyboard shortcuts
          </Item>
        </Command.Group>

        {(accounts.data?.length ?? 0) > 0 && (
          <Command.Group heading="Accounts">
            {accounts.data?.map((a) => (
              <Item
                key={a.id}
                value={`account ${a.label} ${a.id}`}
                keywords={[a.provider, a.status]}
                iconNode={<ProviderIcon provider={a.provider} size="sm" />}
                onSelect={run(() => navigate(`/accounts?account=${encodeURIComponent(a.id)}`))}
              >
                {a.label}
                <span className="ml-2 font-mono text-2xs text-muted">{a.id}</span>
              </Item>
            ))}
          </Command.Group>
        )}

        {(tasks.data?.graph.tasks.length ?? 0) > 0 && (
          <Command.Group heading="Tasks">
            {tasks.data?.graph.tasks.map((t) => (
              <Item
                key={t.id}
                value={`task ${t.id} ${t.title}`}
                keywords={[t.status]}
                iconNode={
                  <span className="flex size-5 items-center justify-center">
                    <TaskStatusDot status={t.status} />
                  </span>
                }
                onSelect={run(() => navigate(`/tasks?task=${encodeURIComponent(t.id)}`))}
              >
                <span className="font-mono text-[12px] text-muted">{t.id}</span>
                <span className="ml-2 truncate">{t.title}</span>
              </Item>
            ))}
          </Command.Group>
        )}

        {(routes.data?.routes.length ?? 0) > 0 && (
          <Command.Group heading="Routes">
            {routes.data?.routes.map((r) => (
              <Item
                key={r.name}
                value={`route davecode/${r.name}`}
                keywords={[r.description ?? '']}
                icon={RouteIcon}
                onSelect={copy(`davecode/${r.name}`, 'model name')}
                hint={<span className="text-2xs text-muted">copy</span>}
              >
                <span className="font-mono">davecode/{r.name}</span>
              </Item>
            ))}
          </Command.Group>
        )}

        <Command.Group heading="Docs">
          {[
            ['README', `${REPO}#readme`],
            ['Architecture', `${REPO}/blob/main/docs/ARCHITECTURE.md`],
            ['HTTP API reference', `${REPO}/blob/main/docs/API.md`],
          ].map(([label, href]) => (
            <Item
              key={label}
              value={`docs ${label}`}
              icon={label === 'Architecture' ? GitBranch : BookOpen}
              onSelect={run(() => window.open(href, '_blank', 'noopener,noreferrer'))}
            >
              {label}
            </Item>
          ))}
        </Command.Group>
      </Command.List>
      <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-2xs text-muted">
        <span className="inline-flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> navigate
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>↵</Kbd> select
        </span>
        <span className="ml-auto inline-flex items-center gap-1">
          <CornerDownLeft aria-hidden className="size-3" strokeWidth={1.75} />
          DaveCode
        </span>
      </div>
    </Command>
  );
}

function Item({
  value,
  keywords,
  icon: Icon,
  iconNode,
  hint,
  onSelect,
  children,
}: {
  value: string;
  keywords?: string[];
  icon?: LucideIcon;
  iconNode?: ReactNode;
  hint?: ReactNode;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <Command.Item
      value={value}
      keywords={keywords}
      onSelect={onSelect}
      className={cn(
        'flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-[13px] text-fg-2 select-none',
        'data-[selected=true]:bg-hover data-[selected=true]:text-fg',
      )}
    >
      {iconNode ??
        (Icon && <Icon aria-hidden className="size-4 shrink-0 text-muted" strokeWidth={1.75} />)}
      <span className="flex min-w-0 flex-1 items-center truncate">{children}</span>
      {hint}
    </Command.Item>
  );
}
