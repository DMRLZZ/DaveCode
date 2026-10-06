import { useSyncExternalStore } from 'react';

/** App-wide overlay state (command palette, shortcuts help) reachable from any screen. */
interface UiState {
  palette: boolean;
  help: boolean;
}

let state: UiState = { palette: false, help: false };
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
};

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
