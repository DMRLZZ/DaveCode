import { useSyncExternalStore } from 'react';

/** App-wide overlay state (command palette, shortcuts help) reachable from any screen. */
interface UiState {
  palette: boolean;
  help: boolean;
  /** Sidebar expanded as an overlay on narrow viewports (< 1024px). */
  sidebarOverlay: boolean;
}

let state: UiState = { palette: false, help: false, sidebarOverlay: false };
const listeners = new Set<() => void>();

function set(patch: Partial<UiState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const ui = {
  openPalette: () => set({ palette: true, help: false }),
  closePalette: () => set({ palette: false }),
  togglePalette: () => set({ palette: !state.palette, help: false }),
  openHelp: () => set({ help: true, palette: false }),
  closeHelp: () => set({ help: false }),
  setSidebarOverlay: (open: boolean) => set({ sidebarOverlay: open }),
};

export const NARROW_QUERY = '(max-width: 1023px)';

/** Toggle the sidebar: persisted collapse on wide screens, a temporary overlay on narrow ones. */
export function toggleSidebar(toggleSetting: () => void): void {
  if (window.matchMedia(NARROW_QUERY).matches) set({ sidebarOverlay: !state.sidebarOverlay });
  else toggleSetting();
}

export function useUi(): UiState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}
