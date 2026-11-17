import type { AgentId } from './agents';

/**
 * The agent the first-run setup asks to open once it is done. Read once by the workspace when
 * it opens with nothing saved, so a finished setup lands on the chosen agent, not a shell.
 */
let pending: AgentId | undefined;

export function requestFirstSession(agent: AgentId): void {
  pending = agent;
}

export function takeFirstSession(): AgentId | undefined {
  const agent = pending;
  pending = undefined;
  return agent;
}
