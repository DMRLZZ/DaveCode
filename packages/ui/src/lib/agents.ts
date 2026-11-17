/**
 * The CLI agents a session can run, in the order they are offered. The desktop app keeps the
 * same list with each one's command and YOLO flag (`packages/desktop/src/agents.ts`); a test
 * there keeps the two in step. Pure data: no DOM, so the desktop test can import it.
 */

export interface AgentInfo {
  id: string;
  label: string;
  /** What the app runs, shown so people know which CLI to install. */
  command: string;
  /** The only colour an agent gets in the workspace. */
  accent: string;
  /** The agent has a flag to work without asking, used in YOLO mode. */
  yolo: boolean;
  /** Where to get it. */
  site: string;
}

export const AGENT_LIST = [
  {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    accent: '#f2a6a6',
    yolo: true,
    site: 'https://claude.com/claude-code',
  },
  {
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    accent: '#8ab4f8',
    yolo: true,
    site: 'https://github.com/openai/codex',
  },
  {
    id: 'agy',
    label: 'Antigravity',
    command: 'agy',
    accent: '#8fd6a8',
    yolo: true,
    site: 'https://antigravity.google',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    command: 'opencode',
    accent: '#e8c98a',
    yolo: true,
    site: 'https://opencode.ai',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    command: 'gemini',
    accent: '#b8a4f0',
    yolo: true,
    site: 'https://github.com/google-gemini/gemini-cli',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    command: 'copilot',
    accent: '#d4d4d8',
    yolo: false,
    site: 'https://github.com/features/copilot/cli',
  },
  {
    id: 'qwen',
    label: 'Qwen Code',
    command: 'qwen',
    accent: '#7fd3e6',
    yolo: true,
    site: 'https://github.com/QwenLM/qwen-code',
  },
  {
    id: 'cursor',
    label: 'Cursor CLI',
    command: 'cursor-agent',
    accent: '#c9c9cf',
    yolo: false,
    site: 'https://cursor.com/cli',
  },
  {
    id: 'amp',
    label: 'Amp',
    command: 'amp',
    accent: '#f0a37a',
    yolo: false,
    site: 'https://ampcode.com',
  },
  {
    id: 'aider',
    label: 'Aider',
    command: 'aider',
    accent: '#9fe0a8',
    yolo: true,
    site: 'https://aider.chat',
  },
  {
    id: 'crush',
    label: 'Crush',
    command: 'crush',
    accent: '#e9a6d6',
    yolo: false,
    site: 'https://github.com/charmbracelet/crush',
  },
  {
    id: 'davecode',
    label: 'DaveCode',
    command: 'davecode',
    accent: '#ffffff',
    yolo: false,
    site: 'https://davecode.app',
  },
] as const satisfies readonly AgentInfo[];

export type AgentId = (typeof AGENT_LIST)[number]['id'];
export const AGENT_IDS: readonly AgentId[] = AGENT_LIST.map((agent) => agent.id);

export function agentInfo(id: string): AgentInfo | undefined {
  return AGENT_LIST.find((agent) => agent.id === id);
}

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && AGENT_IDS.includes(value as AgentId);
}
