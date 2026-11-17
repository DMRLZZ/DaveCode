import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { AGENT_IDS } from './agents';
import { SHELL_IDS } from './shells';

/**
 * The app's own preferences, in `<userData>/preferences.json`. The workspace page runs on a new
 * local port every launch, so its own storage starts empty each time; these survive. The app
 * also reads them itself: the shell and YOLO mode decide how a pane starts.
 */

const id = z.string().regex(/^[a-z0-9-]{1,40}$/);

export const preferencesSchema = z.object({
  version: z.literal(1),
  /** The first-run setup was finished or skipped. */
  onboarded: z.boolean(),
  /** Where new agents open: their own terminal UI, or DaveCode's chat. */
  workMode: z.enum(['terminal', 'chat']),
  defaultAgent: z.enum(AGENT_IDS as [string, ...string[]]),
  /** Agents start with their own flag to run commands and edit files without asking. */
  yolo: z.boolean(),
  colorMode: z.enum(['system', 'dark', 'light']),
  /** Terminal theme for each color mode; the page knows the ids and falls back if one is gone. */
  terminalTheme: z.object({ dark: id, light: id }),
  /** Windows only; elsewhere panes use the login shell. */
  shell: z.enum(SHELL_IDS),
  rightClick: z.enum(['paste', 'menu']),
  notifications: z.object({ enabled: z.boolean(), sound: id }),
  /** "Continue on this device" was chosen instead of a DaveCode account. */
  localMode: z.boolean(),
});

export type Preferences = z.infer<typeof preferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = {
  version: 1,
  onboarded: false,
  workMode: 'terminal',
  defaultAgent: 'claude',
  yolo: false,
  colorMode: 'dark',
  terminalTheme: { dark: 'davecode-dark', light: 'davecode-light' },
  shell: 'auto',
  rightClick: 'paste',
  notifications: { enabled: true, sound: 'chime' },
  localMode: false,
};

export const preferencesFile = (userData: string) => join(userData, 'preferences.json');

/**
 * The saved preferences over the defaults. Each field is checked on its own, so one value that a
 * newer or older version wrote differently does not reset everything else.
 */
export function readPreferences(file: string): Preferences {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return structuredClone(DEFAULT_PREFERENCES);
  }
  if (typeof raw !== 'object' || raw === null) return structuredClone(DEFAULT_PREFERENCES);
  const merged: Record<string, unknown> = structuredClone(DEFAULT_PREFERENCES);
  const shape = preferencesSchema.shape;
  for (const key of Object.keys(shape) as (keyof typeof shape)[]) {
    if (key === 'version') continue;
    const value = (raw as Record<string, unknown>)[key];
    if (shape[key].safeParse(value).success) merged[key] = value;
  }
  return merged as Preferences;
}

/** Validates and writes. Returns the stored preferences, or undefined when nothing was written. */
export function writePreferences(file: string, value: unknown): Preferences | undefined {
  const parsed = preferencesSchema.safeParse(value);
  if (!parsed.success) return undefined;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(parsed.data));
    return parsed.data;
  } catch {
    return undefined;
  }
}
