import type { EventBus } from '../events';
import type { AgentRunner, OrchestratorService, OrchestratorWorkspace } from './contract';

export interface OrchestratorServiceOptions {
  /** Absolute project root. */
  projectDir: string;
  /** DaveCode home: runs are kept under `<home>/orchestrator/`. */
  home: string;
  events: EventBus;
  runner: AgentRunner;
  workspace: OrchestratorWorkspace;
  now?: () => Date;
}

/** STUB: replaced by the engine implementation. */
export function createOrchestratorService(
  _options: OrchestratorServiceOptions,
): OrchestratorService {
  throw new Error('not implemented');
}
