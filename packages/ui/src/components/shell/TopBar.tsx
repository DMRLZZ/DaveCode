import { CircleHelp, Moon, Search, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { resolveTheme, updateSettings, useSettings } from '../../lib/settings';
import { Button } from '../ui/Button';
import { Kbd, modKey } from '../ui/Kbd';

export function TopBar({
  title,
  status,
  onOpenPalette,
  onOpenHelp,
}: {
  title: string;
  status?: ReactNode;
  onOpenPalette: () => void;
  onOpenHelp: () => void;
}) {
  const { theme } = useSettings();
  const effective = resolveTheme(theme);
  const next = effective === 'dark' ? 'light' : 'dark';

  return (
    <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-3 border-b border-line bg-bg px-4 md:px-5">
      <p className="flex min-w-0 items-center gap-1.5 text-[13px]">
        <span className="hidden text-muted sm:inline">DaveCode</span>
        <span aria-hidden className="hidden text-faint sm:inline">
          /
        </span>
        <span className="truncate font-medium text-fg">{title}</span>
      </p>

      <div className="ml-auto flex items-center gap-2">
        {status}
        <button
          type="button"
          onClick={onOpenPalette}
          aria-label="Open command palette"
          aria-keyshortcuts="Control+K Meta+K"
          className="hidden h-8 w-56 items-center gap-2 rounded-md border border-line bg-panel px-2.5 text-[12px] text-muted transition-colors duration-150 hover:border-line-strong hover:text-fg-2 md:flex"
        >
          <Search aria-hidden className="size-3.5" strokeWidth={1.75} />
          <span>Search or jump to…</span>
          <span className="ml-auto flex items-center gap-0.5">
            <Kbd>{modKey}</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
        <Button
          variant="ghost"
          iconOnly
          icon={Search}
          aria-label="Open command palette"
          onClick={onOpenPalette}
          className="md:hidden"
        />
        <Button
          variant="ghost"
          iconOnly
          icon={effective === 'dark' ? Sun : Moon}
          aria-label={`Switch to ${next} theme`}
          title={`Switch to ${next} theme`}
          onClick={() => updateSettings({ theme: next })}
        />
        <Button
          variant="ghost"
          iconOnly
          icon={CircleHelp}
          aria-label="Keyboard shortcuts"
          aria-keyshortcuts="Shift+Slash"
          title="Keyboard shortcuts  ?"
          onClick={onOpenHelp}
        />
      </div>
    </header>
  );
}
