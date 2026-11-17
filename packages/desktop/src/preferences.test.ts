import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  preferencesFile,
  readPreferences,
  writePreferences,
} from './preferences';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'davecode-preferences-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('preferences', () => {
  it('starts from the defaults', () => {
    expect(readPreferences(preferencesFile(dir))).toEqual(DEFAULT_PREFERENCES);
    writeFileSync(preferencesFile(dir), '{{{');
    expect(readPreferences(preferencesFile(dir))).toEqual(DEFAULT_PREFERENCES);
  });

  it('round-trips what the page chose', () => {
    const chosen = {
      ...DEFAULT_PREFERENCES,
      onboarded: true,
      workMode: 'chat' as const,
      defaultAgent: 'codex',
      yolo: true,
      colorMode: 'light' as const,
      terminalTheme: { dark: 'tokyo-night', light: 'github-light' },
      shell: 'gitbash' as const,
      rightClick: 'menu' as const,
      notifications: { enabled: false, sound: 'chime' },
      localMode: true,
    };
    expect(writePreferences(preferencesFile(dir), chosen)).toEqual(chosen);
    expect(readPreferences(preferencesFile(dir))).toEqual(chosen);
  });

  it('refuses what is not a preference and keeps only known fields', () => {
    const file = preferencesFile(dir);
    for (const bad of [
      null,
      { ...DEFAULT_PREFERENCES, defaultAgent: 'rm -rf /' },
      { ...DEFAULT_PREFERENCES, shell: 'C:\\evil.exe' },
      { ...DEFAULT_PREFERENCES, terminalTheme: { dark: '../x', light: 'a' } },
      { ...DEFAULT_PREFERENCES, version: 2 },
    ]) {
      expect(writePreferences(file, bad)).toBeUndefined();
    }
    expect(writePreferences(file, { ...DEFAULT_PREFERENCES, token: 'secret' })).toBeDefined();
    expect(readFileSync(file, 'utf8')).not.toContain('secret');
  });

  it('keeps every valid field of a file another version wrote', () => {
    const file = preferencesFile(dir);
    writeFileSync(
      file,
      JSON.stringify({ version: 1, yolo: true, shell: 'fish', colorMode: 'light', extra: 1 }),
    );
    expect(readPreferences(file)).toEqual({
      ...DEFAULT_PREFERENCES,
      yolo: true,
      colorMode: 'light',
    });
  });
});
