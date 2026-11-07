import type { PaneKind } from '../../lib/desktop';

/** Pane kinds in toolbar order. The accent is the only colour an agent gets in the workspace. */
export const KINDS: { kind: PaneKind; label: string; accent: string }[] = [
  { kind: 'shell', label: 'Shell', accent: '#a1a1aa' },
  { kind: 'claude', label: 'Claude Code', accent: '#f2a6a6' },
  { kind: 'codex', label: 'Codex', accent: '#8ab4f8' },
  { kind: 'agy', label: 'Antigravity', accent: '#8fd6a8' },
  { kind: 'davecode', label: 'DaveCode', accent: '#ffffff' },
];

export function kindMeta(kind: PaneKind): { kind: PaneKind; label: string; accent: string } {
  return KINDS.find((k) => k.kind === kind) ?? { kind, label: 'Shell', accent: '#a1a1aa' };
}
