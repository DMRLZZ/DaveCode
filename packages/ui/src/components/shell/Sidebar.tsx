import { BookOpen, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { cn } from '../../lib/cn';
import { NAV, type NavItem } from '../../lib/nav';
import { Link } from '../../lib/router';
import { Kbd } from '../ui/Kbd';

const DOCS_URL = 'https://github.com/DMRLZZ/DaveCode/tree/main/docs';

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden className={className}>
      <rect
        x="0.5"
        y="0.5"
        width="31"
        height="31"
        rx="7.5"
        className="fill-raised stroke-line-strong"
      />
      <path
        d="M10 9h5.5a7 7 0 0 1 0 14H10V9Z"
        className="stroke-fg"
        strokeWidth="2.25"
        strokeLinejoin="round"
      />
      <circle cx="22.5" cy="16" r="2.25" className="fill-accent" />
    </svg>
  );
}

export function Sidebar({
  activeId,
  collapsed,
  onToggle,
  version,
}: {
  activeId: string | undefined;
  collapsed: boolean;
  onToggle: () => void;
  version?: string;
}) {
  const groups = ['Gateway', 'Engine'] as const;
  const settings = NAV.find((n) => n.id === 'settings');

  return (
    <aside
      aria-label="Primary"
      className={cn(
        'sticky top-0 flex h-dvh shrink-0 flex-col border-r border-line bg-panel transition-[width] duration-200 ease-snappy',
        collapsed ? 'w-[52px]' : 'w-[216px]',
      )}
    >
      <div
        className={cn(
          'flex h-12 items-center gap-2.5 border-b border-line',
          collapsed ? 'justify-center px-0' : 'px-3.5',
        )}
      >
        <BrandMark className="size-6 shrink-0" />
        {!collapsed && (
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="text-[14px] font-semibold tracking-tight text-fg">DaveCode</span>
            {version && <span className="truncate font-mono text-2xs text-faint">v{version}</span>}
          </div>
        )}
      </div>

      <nav
        aria-label="Main"
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 py-3"
      >
        {groups.map((group) => (
          <div key={group} className="flex flex-col gap-px">
            {!collapsed ? (
              <p className="eyebrow px-2 pb-1.5">{group}</p>
            ) : (
              <div aria-hidden className="mx-2 mb-1.5 h-px bg-line first:hidden" />
            )}
            <ul className="flex flex-col gap-px">
              {NAV.filter((n) => n.group === group).map((item) => (
                <li key={item.id}>
                  <NavLink item={item} active={item.id === activeId} collapsed={collapsed} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="flex flex-col gap-px border-t border-line px-2 py-2">
        {settings && (
          <NavLink item={settings} active={activeId === 'settings'} collapsed={collapsed} />
        )}
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noreferrer"
          title={collapsed ? 'Documentation' : undefined}
          className={cn(navClass(false, collapsed))}
        >
          <BookOpen aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
          {!collapsed ? (
            <span>Docs</span>
          ) : (
            <span className="sr-only">Documentation (opens in a new tab)</span>
          )}
        </a>
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar  [' : 'Collapse sidebar  ['}
          className={cn(navClass(false, collapsed))}
        >
          {collapsed ? (
            <PanelLeftOpen aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
          ) : (
            <>
              <PanelLeftClose aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
              <span>Collapse</span>
              <Kbd className="ml-auto">[</Kbd>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}

function navClass(active: boolean, collapsed: boolean) {
  return cn(
    'group relative flex h-8 w-full items-center gap-2.5 rounded-md text-[13px] transition-colors duration-150 ease-snappy',
    collapsed ? 'justify-center px-0' : 'px-2',
    active ? 'bg-active text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg',
  );
}

function NavLink({
  item,
  active,
  collapsed,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
}) {
  const Icon = item.icon;
  return (
    <Link
      to={item.path}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? `${item.label}  g ${item.key}` : undefined}
      className={navClass(active, collapsed)}
    >
      {active && (
        <span
          aria-hidden
          className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-accent"
        />
      )}
      <Icon
        aria-hidden
        className={cn('size-4 shrink-0', active ? 'text-fg' : 'text-muted group-hover:text-fg-2')}
        strokeWidth={1.75}
      />
      {collapsed ? (
        <span className="sr-only">{item.label}</span>
      ) : (
        <>
          <span className="truncate">{item.label}</span>
          <span className="ml-auto hidden items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 lg:flex">
            <Kbd>g</Kbd>
            <Kbd>{item.key}</Kbd>
          </span>
        </>
      )}
    </Link>
  );
}
