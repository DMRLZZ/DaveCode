import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import { AGENT_IDS, type AgentId } from './agents';
import { preferencesBridge } from './desktop';
import { updateSettings } from './settings';
import { DEFAULT_SOUND, SOUND_IDS, type SoundId } from './sounds';
import { DEFAULT_TERMINAL_THEMES, TERMINAL_THEME_IDS } from './terminal-themes';

/**
 * How the person likes to work: chosen in the first-run setup, changed in Settings. In the
 * desktop app the app itself keeps them (the page's own storage does not survive a launch);
 * in a browser tab they live in localStorage.
 */

export const SHELL_IDS = ['auto', 'powershell', 'pwsh', 'cmd', 'gitbash', 'wsl'] as const;
export type ShellId = (typeof SHELL_IDS)[number];
export type ColorMode = 'system' | 'dark' | 'light';

export interface Preferences {
  version: 1;
  onboarded: boolean;
  workMode: 'terminal' | 'chat';
  defaultAgent: AgentId;
  yolo: boolean;
  colorMode: ColorMode;
  terminalTheme: { dark: string; light: string };
  shell: ShellId;
  rightClick: 'paste' | 'menu';
  notifications: { enabled: boolean; sound: SoundId };
  localMode: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  version: 1,
  onboarded: false,
  workMode: 'terminal',
  defaultAgent: 'claude',
  yolo: false,
  colorMode: 'dark',
  terminalTheme: { ...DEFAULT_TERMINAL_THEMES },
  shell: 'auto',
  rightClick: 'paste',
  notifications: { enabled: true, sound: DEFAULT_SOUND },
  localMode: false,
};

const FIELDS: { [K in Exclude<keyof Preferences, 'version'>]: z.ZodType<Preferences[K]> } = {
  onboarded: z.boolean(),
  workMode: z.enum(['terminal', 'chat']),
  defaultAgent: z.enum(AGENT_IDS as [AgentId, ...AgentId[]]),
  yolo: z.boolean(),
  colorMode: z.enum(['system', 'dark', 'light']),
  terminalTheme: z.object({
    dark: z.enum(TERMINAL_THEME_IDS as [string, ...string[]]),
    light: z.enum(TERMINAL_THEME_IDS as [string, ...string[]]),
  }),
  shell: z.enum(SHELL_IDS),
  rightClick: z.enum(['paste', 'menu']),
  notifications: z.object({
    enabled: z.boolean(),
    sound: z.enum(SOUND_IDS),
  }),
  localMode: z.boolean(),
};

/** Stored preferences over the defaults, field by field: one odd value never resets the rest. */
export function parsePreferences(value: unknown): Preferences {
  const merged = structuredClone(DEFAULT_PREFERENCES) as unknown as Record<string, unknown>;
  if (typeof value !== 'object' || value === null) return merged as unknown as Preferences;
  const raw = value as Record<string, unknown>;
  for (const [key, schema] of Object.entries(FIELDS)) {
    const parsed = (schema as z.ZodType).safeParse(raw[key]);
    if (parsed.success) merged[key] = parsed.data;
  }
  return merged as unknown as Preferences;
}

const STORAGE_KEY = 'davecode.preferences';

let current: Preferences = structuredClone(DEFAULT_PREFERENCES);
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Reads the stored preferences; resolves within `timeoutMs` even if the app does not answer. */
export async function loadPreferences(timeoutMs = 2000): Promise<Preferences> {
  const bridge = preferencesBridge();
  let stored: unknown;
  if (bridge) {
    stored = await Promise.race([
      bridge.load().catch(() => undefined),
      new Promise((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
    ]);
  } else {
    try {
      stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
    } catch {
      stored = undefined;
    }
  }
  current = parsePreferences(stored);
  emit();
  return current;
}

export function getPreferences(): Preferences {
  return current;
}

/** Changes some preferences now and stores them. */
export function updatePreferences(patch: Partial<Omit<Preferences, 'version'>>): void {
  current = { ...current, ...patch };
  emit();
  const bridge = preferencesBridge();
  if (bridge) {
    bridge.save(current).catch(() => {
      /* Not stored: the choice still holds until the app closes. */
    });
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* Storage unavailable: the choice holds for this tab. */
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePreferences(): Preferences {
  return useSyncExternalStore(subscribe, getPreferences, getPreferences);
}

/** The color mode in effect: `system` follows the operating system. */
export function resolvedColorMode(mode: ColorMode): 'dark' | 'light' {
  if (mode !== 'system') return mode;
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * Sets the color mode everywhere: the preference the app keeps, and the theme the page paints
 * with (the dashboard reads it from the settings).
 */
export function setColorMode(mode: ColorMode): void {
  updatePreferences({ colorMode: mode });
  updateSettings({ theme: mode });
}

function systemMode(): 'dark' | 'light' {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function subscribeSystem(listener: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const query = window.matchMedia('(prefers-color-scheme: light)');
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

/** The color mode in effect right now, following the system when the preference says so. */
export function useColorMode(): 'dark' | 'light' {
  const { colorMode } = usePreferences();
  const system = useSyncExternalStore(subscribeSystem, systemMode, () => 'dark' as const);
  return colorMode === 'system' ? system : colorMode;
}
