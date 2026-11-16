import { describe, expect, it } from 'vitest';
import {
  cleanSessionName,
  isWorkspaceShortcut,
  SESSION_NAME_MAX_LENGTH,
  uniqueSessionName,
  workspaceAction,
} from './sessions';

const key = (
  k: string,
  mods: Partial<Record<'ctrl' | 'meta' | 'shift' | 'alt', boolean>> = {},
) => ({
  key: k,
  ctrlKey: mods.ctrl ?? false,
  metaKey: mods.meta ?? false,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
});

describe('uniqueSessionName', () => {
  it('numbers a name that is already taken', () => {
    expect(uniqueSessionName('Codex', [])).toBe('Codex');
    expect(uniqueSessionName('Codex', ['Codex'])).toBe('Codex 2');
    expect(uniqueSessionName('Codex', ['Codex', 'Codex 2', 'Shell'])).toBe('Codex 3');
    // A closed pane frees its number.
    expect(uniqueSessionName('Codex', ['Codex', 'Codex 3'])).toBe('Codex 2');
  });
});

describe('cleanSessionName', () => {
  it('tidies what was typed and keeps the old name when it is empty', () => {
    expect(cleanSessionName('  api   server ', 'Shell')).toBe('api server');
    expect(cleanSessionName('   ', 'Shell')).toBe('Shell');
    expect(cleanSessionName('x'.repeat(90), 'Shell')).toHaveLength(SESSION_NAME_MAX_LENGTH);
  });
});

describe('workspaceAction', () => {
  it('maps Ctrl or ⌘ + Shift + key to an action', () => {
    expect(workspaceAction(key('D', { ctrl: true, shift: true }))).toBe('split-right');
    expect(workspaceAction(key('e', { meta: true, shift: true }))).toBe('split-down');
    expect(workspaceAction(key('Enter', { ctrl: true, shift: true }))).toBe('zoom');
    expect(workspaceAction(key('M', { ctrl: true, shift: true }))).toBe('minimize');
    expect(workspaceAction(key('W', { ctrl: true, shift: true }))).toBe('close');
    expect(workspaceAction(key('B', { ctrl: true, shift: true }))).toBe('sidebar');
  });

  it('leaves everything a shell or an agent uses alone', () => {
    expect(isWorkspaceShortcut(key('d', { ctrl: true }))).toBe(false);
    expect(isWorkspaceShortcut(key('w', { ctrl: true }))).toBe(false);
    expect(isWorkspaceShortcut(key('D', { shift: true }))).toBe(false);
    expect(isWorkspaceShortcut(key('C', { ctrl: true, shift: true }))).toBe(false);
    expect(isWorkspaceShortcut(key('D', { ctrl: true, shift: true, alt: true }))).toBe(false);
    expect(isWorkspaceShortcut(key('Enter'))).toBe(false);
  });
});
