import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { THEME_MODES, type ThemeMode } from '../ui/theme';

/** Per-user terminal preferences chosen during first-run setup. */
export interface Preferences {
  theme?: ThemeMode;
  /** First-run setup finished (it is not shown again). */
  onboarded?: boolean;
}

const schema = z.object({
  theme: z.enum(THEME_MODES as [ThemeMode, ...ThemeMode[]]).optional(),
  onboarded: z.boolean().optional(),
});

export function preferencesPath(home: string): string {
  return join(home, 'preferences.json');
}

/** Missing or unreadable preferences behave like a first run. */
export function readPreferences(home: string): Preferences {
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(preferencesPath(home), 'utf8')));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function writePreferences(home: string, update: Preferences): Preferences {
  const next = { ...readPreferences(home), ...update };
  const path = preferencesPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
