import { AGENT_LIST } from '../../lib/agents';
import type { PaneKind } from '../../lib/desktop';

export interface KindMeta {
  kind: PaneKind;
  label: string;
  accent: string;
}

/** Every session kind: a shell, then each agent. The accent is the only colour a kind gets. */
export const KINDS: KindMeta[] = [
  { kind: 'shell', label: 'Shell', accent: '#a1a1aa' },
  ...AGENT_LIST.map((agent) => ({ kind: agent.id, label: agent.label, accent: agent.accent })),
];

export function kindMeta(kind: PaneKind): KindMeta {
  return KINDS.find((k) => k.kind === kind) ?? { kind, label: 'Shell', accent: '#a1a1aa' };
}
