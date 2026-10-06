import {
  Asterisk,
  Globe,
  Hexagon,
  type LucideIcon,
  Server,
  Sparkle,
  SquareTerminal,
  TerminalSquare,
} from 'lucide-react';
import type { ProviderKind } from './types';

export type AuthKind = 'api-key' | 'optional-key' | 'cli' | 'browser';

export interface ProviderMeta {
  kind: ProviderKind;
  label: string;
  icon: LucideIcon;
  auth: AuthKind;
  /** One-line explanation shown in the add-account sheet. */
  blurb: string;
  secretLabel?: string;
  secretPlaceholder?: string;
  experimental?: boolean;
  subscription?: boolean;
}

/** Display metadata per provider. Glyphs are neutral symbols, not vendor logos. */
export const PROVIDERS: Record<ProviderKind, ProviderMeta> = {
  anthropic: {
    kind: 'anthropic',
    label: 'Anthropic API',
    icon: Asterisk,
    auth: 'api-key',
    blurb: 'Claude models through the Messages API with an API key.',
    secretLabel: 'API key',
    secretPlaceholder: 'sk-ant-…',
  },
  openai: {
    kind: 'openai',
    label: 'OpenAI API',
    icon: Hexagon,
    auth: 'api-key',
    blurb: 'GPT models with an OpenAI API key.',
    secretLabel: 'API key',
    secretPlaceholder: 'sk-…',
  },
  gemini: {
    kind: 'gemini',
    label: 'Gemini API',
    icon: Sparkle,
    auth: 'api-key',
    blurb: 'Google Gemini through AI Studio or Vertex with an API key.',
    secretLabel: 'API key',
    secretPlaceholder: 'AIza…',
  },
  'openai-compatible': {
    kind: 'openai-compatible',
    label: 'OpenAI-compatible',
    icon: Server,
    auth: 'optional-key',
    blurb: 'OpenRouter, Ollama, LM Studio, vLLM, LiteLLM… any /v1/chat/completions endpoint.',
    secretLabel: 'API key (optional)',
    secretPlaceholder: 'Leave empty for local servers',
  },
  'claude-cli': {
    kind: 'claude-cli',
    label: 'Claude Code CLI',
    icon: SquareTerminal,
    auth: 'cli',
    blurb: 'Your Claude login, isolated in its own CLAUDE_CONFIG_DIR sandbox.',
    subscription: true,
  },
  'codex-cli': {
    kind: 'codex-cli',
    label: 'Codex CLI',
    icon: TerminalSquare,
    auth: 'cli',
    blurb: 'Your ChatGPT/OpenAI login, isolated in its own CODEX_HOME sandbox.',
    subscription: true,
  },
  'gemini-web': {
    kind: 'gemini-web',
    label: 'Gemini web',
    icon: Globe,
    auth: 'browser',
    blurb: 'Drives a Gemini web session through a dedicated Chromium profile.',
    experimental: true,
    subscription: true,
  },
};

export const PROVIDER_ORDER: ProviderKind[] = [
  'anthropic',
  'openai',
  'gemini',
  'openai-compatible',
  'claude-cli',
  'codex-cli',
  'gemini-web',
];

export function providerMeta(kind: ProviderKind): ProviderMeta {
  return PROVIDERS[kind] ?? { ...PROVIDERS['openai-compatible'], kind, label: kind };
}
