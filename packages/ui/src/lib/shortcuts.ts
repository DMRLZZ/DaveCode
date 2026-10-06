import { useEffect } from 'react';
import { NAV } from './nav';
import { navigate } from './router';
import { getSettings, updateSettings } from './settings';
import { ui } from './ui-state';

export interface ShortcutDef {
  keys: string[];
  description: string;
}

export const SHORTCUT_GROUPS: { title: string; items: ShortcutDef[] }[] = [
  {
    title: 'General',
    items: [
      { keys: ['mod', 'K'], description: 'Open the command palette' },
      { keys: ['?'], description: 'Show keyboard shortcuts' },
      { keys: ['/'], description: 'Focus the filter on this page' },
      { keys: ['['], description: 'Collapse or expand the sidebar' },
      { keys: ['Esc'], description: 'Close the open dialog or sheet' },
    ],
  },
  {
    title: 'Go to',
    items: NAV.map((n) => ({ keys: ['g', n.key], description: n.label })),
  },
  {
    title: 'Charts and lists',
    items: [
      { keys: ['←', '→'], description: 'Step through chart values (when the chart is focused)' },
      { keys: ['Home', 'End'], description: 'First or last chart value' },
      { keys: ['Tab'], description: 'Move between task graph nodes' },
    ],
  },
];

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** True when a modal (<dialog open>) is showing; page shortcuts are suspended then. */
function modalOpen(): boolean {
  return document.querySelector('dialog[open]') !== null;
}

/** Install global keyboard shortcuts (call once, in the app shell). */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    let pendingG = 0;

    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ui.togglePalette();
        return;
      }
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target) || modalOpen()) return;

      if (pendingG && Date.now() - pendingG < 1200) {
        pendingG = 0;
        const item = NAV.find((n) => n.key === e.key.toLowerCase());
        if (item) {
          e.preventDefault();
          navigate(item.path);
        }
        return;
      }

      switch (e.key) {
        case 'g':
          pendingG = Date.now();
          break;
        case '?':
          e.preventDefault();
          ui.openHelp();
          break;
        case '[':
          e.preventDefault();
          updateSettings({ sidebarCollapsed: !getSettings().sidebarCollapsed });
          break;
        case '/': {
          const input = document.querySelector<HTMLInputElement>('[data-filter-input]');
          if (input) {
            e.preventDefault();
            input.focus();
            input.select();
          }
          break;
        }
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
