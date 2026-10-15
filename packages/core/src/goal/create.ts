/** Wires a {@link GoalService} from a core {@link Engine}: the entry point for the CLI and server. */
import type { Executor } from '../autonomous/executor';
import { truncateHead } from '../autonomous/process';
import { WorkspaceLock } from '../autonomous/workspace-lock';
import type { ProjectBrain } from '../brain/project';
import type { Engine } from '../engine';
import { RunnerCodeTasks } from './code-tasks';
import { GoalOrchestrator } from './orchestrator';
import { GoalService } from './service';
import { GoalStore } from './store';

type EngineDeps = Pick<Engine, 'config' | 'router' | 'accounts' | 'sandboxes' | 'events' | 'paths'>;

export interface CreateGoalServiceOptions {
  /** Project brain: enables code tasks and project context. Its root holds the goals. */
  brain: ProjectBrain;
  /** Shared with the autonomous runner of the same working tree (default: a private lock). */
  lock?: WorkspaceLock;
  /** Compact budget summary shown to every agent and runner pass. */
  budgetContext?: () => string | Promise<string>;
  /** Override the runner's executor for code tasks (tests). */
  executor?: Executor;
}

const PROJECT_CONTEXT_CHARS = 3_000;

export function createGoalService(engine: EngineDeps, opts: CreateGoalServiceOptions): GoalService {
  const { brain } = opts;
  const lock = opts.lock ?? new WorkspaceLock();
  const store = new GoalStore(brain.root);
  const codeRunner = new RunnerCodeTasks({
    engine,
    brain,
    lock,
    ...(opts.budgetContext ? { contextExtras: opts.budgetContext } : {}),
    ...(opts.executor ? { executor: opts.executor } : {}),
  });
  const projectContext = async (): Promise<string> => {
    if (!(await brain.isInitialised())) return '';
    const [architecture, state] = await Promise.all([brain.readArchitecture(), brain.readState()]);
    return [
      `ARCHITECTURE.md:\n${truncateHead(architecture.trim(), PROJECT_CONTEXT_CHARS)}`,
      `STATE.md:\n${truncateHead(state.trim(), PROJECT_CONTEXT_CHARS)}`,
    ].join('\n\n');
  };
  const orchestrator = new GoalOrchestrator({
    router: engine.router,
    store,
    events: engine.events,
    config: engine.config.goal,
    codeRunner,
    projectContext,
    ...(opts.budgetContext ? { budgetContext: opts.budgetContext } : {}),
  });
  return new GoalService({ orchestrator, store, lock });
}
