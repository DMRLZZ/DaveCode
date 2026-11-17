import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The CLI agents a pane can run. The renderer only ever sends an id from this list; the command
 * and its flags come from here. `yolo` is the agent's own flag for running without asking, taken
 * from each CLI's help or documentation; agents without one keep their own permission settings.
 * The UI keeps the same list in `packages/ui/src/lib/agents.ts`; a test keeps the two in step.
 */
export const AGENTS = {
  claude: { command: 'claude', yolo: ['--dangerously-skip-permissions'] },
  codex: { command: 'codex', yolo: ['--dangerously-bypass-approvals-and-sandbox'] },
  agy: { command: 'agy', yolo: ['--dangerously-skip-permissions'] },
  opencode: { command: 'opencode', yolo: ['--auto'] },
  gemini: { command: 'gemini', yolo: ['--yolo'] },
  copilot: { command: 'copilot', yolo: [] },
  qwen: { command: 'qwen', yolo: ['--yolo'] },
  cursor: { command: 'cursor-agent', yolo: [] },
  amp: { command: 'amp', yolo: [] },
  aider: { command: 'aider', yolo: ['--yes-always'] },
  crush: { command: 'crush', yolo: [] },
  davecode: { command: 'davecode', yolo: [] },
} as const satisfies Record<string, { command: string; yolo: readonly string[] }>;

export type AgentId = keyof typeof AGENTS;
export const AGENT_IDS = Object.keys(AGENTS) as AgentId[];

/** The command line a pane types into its shell to start the agent. */
export function agentCommand(id: AgentId, yolo: boolean): string {
  const agent = AGENTS[id];
  return [agent.command, ...(yolo ? agent.yolo : [])].join(' ');
}

const WINDOWS_EXTENSIONS = ['.exe', '.cmd', '.bat', '.com', '.ps1'];

/**
 * Whether `command` can be found on PATH, the way a shell would find it. Only presence is
 * checked: a CLI that is installed but signed out still counts.
 */
export function onPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathValue = env.PATH ?? env.Path ?? '';
  const dirs = pathValue.split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const extensions =
    platform === 'win32'
      ? (env.PATHEXT?.split(';').map((e) => e.toLowerCase()) ?? WINDOWS_EXTENSIONS).concat([''])
      : [''];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = join(dir.replace(/^"|"$/g, ''), command + extension);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return true;
      } catch {
        /* An unreadable PATH entry is skipped. */
      }
    }
  }
  return false;
}

/** Which agents are installed, in registry order. */
export function detectAgents(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { id: AgentId; installed: boolean }[] {
  return AGENT_IDS.map((id) => ({ id, installed: onPath(AGENTS[id].command, env, platform) }));
}
