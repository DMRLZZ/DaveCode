import type { AgentRunner } from './contract';

export interface CliAgentRunnerOptions {
  /** Environment for the CLIs (default `process.env`). Their global sign-in is used. */
  env?: NodeJS.ProcessEnv;
}

/** STUB: replaced by the headless Claude Code / Codex / Antigravity runners. */
export function createCliAgentRunner(_options: CliAgentRunnerOptions = {}): AgentRunner {
  throw new Error('not implemented');
}
