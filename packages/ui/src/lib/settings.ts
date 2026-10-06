import { useSyncExternalStore } from 'react';

/** User preferences persisted in localStorage. The bearer token never leaves this browser. */
export type ThemePref = 'dark' | 'light' | 'system';
export type DataMode = 'auto' | 'live' | 'mock';

export interface Settings {
  /** Gateway origin, e.g. `http://127.0.0.1:4040`. Empty = same origin (dev proxy / served by gateway). */
  gatewayUrl: string;
  token: string;
  theme: ThemePref;
  /** `auto` falls back to mock data when the gateway is unreachable. */
  dataMode: DataMode;
  sidebarCollapsed: boolean;
}

const KEYS = {
  gatewayUrl: 'davecode.gatewayUrl',
  token: 'davecode.token',
  theme: 'davecode.theme',
  dataMode: 'davecode.dataMode',
  sidebarCollapsed: 'davecode.sidebarCollapsed',
} as const satisfies Record<keyof Settings, string>;

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    if (value === '') window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode, quota); settings then live for the session.
  }
}

function load(): Settings {
  const theme = read(KEYS.theme);
  const mode = read(KEYS.dataMode);
  return {
    gatewayUrl: read(KEYS.gatewayUrl) ?? '',
    token: read(KEYS.token) ?? '',
    theme: theme === 'light' || theme === 'system' ? theme : 'dark',
    dataMode: mode === 'live' || mode === 'mock' ? mode : 'auto',
    sidebarCollapsed: read(KEYS.sidebarCollapsed) === '1',
  };
}

let current: Settings = typeof window === 'undefined' ? defaults() : load();
const listeners = new Set<() => void>();

function defaults(): Settings {
  return { gatewayUrl: '', token: '', theme: 'dark', dataMode: 'auto', sidebarCollapsed: false };
}

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  for (const [k, v] of Object.entries(patch) as [keyof Settings, Settings[keyof Settings]][]) {
    const key = KEYS[k];
    if (k === 'sidebarCollapsed') write(key, v ? '1' : '');
    else if (k === 'theme') write(key, String(v));
    else write(key, String(v ?? ''));
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings, getSettings);
}

/** `?mock=1` in the page URL or `VITE_DAVECODE_MOCK=1` at build time forces mock mode. */
export function mockForced(): boolean {
  if (import.meta.env.VITE_DAVECODE_MOCK === '1') return true;
  if (typeof window === 'undefined') return false;
  const fromSearch = new URLSearchParams(window.location.search).get('mock');
  const hashQuery = window.location.hash.split('?')[1] ?? '';
  const fromHash = new URLSearchParams(hashQuery).get('mock');
  return fromSearch === '1' || fromHash === '1';
}

export function resolveTheme(pref: ThemePref): 'dark' | 'light' {
  if (pref !== 'system') return pref;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Keep `<html data-theme>` in sync with the preference (and the OS, for `system`). */
export function applyTheme(pref: ThemePref): () => void {
  const set = () => {
    document.documentElement.dataset.theme = resolveTheme(pref);
  };
  set();
  if (pref !== 'system') return () => {};
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  mq.addEventListener('change', set);
  return () => mq.removeEventListener('change', set);
}
