/**
 * One goal at a time per workspace: starts goals in the background, exposes their state and
 * cancels them. Structurally satisfies the server's `GoalControl`.
 */
import type { WorkspaceLock } from '../autonomous/workspace-lock';
import type { Goal } from '../types';
import { type GoalOrchestrator, isTerminalGoal, type NewGoalInput } from './orchestrator';
import type { GoalStore } from './store';

export type GoalErrorCode = 'busy' | 'not_found' | 'invalid';

export class GoalError extends Error {
  /** HTTP status hint for the gateway. */
  readonly statusCode: number;

  constructor(
    readonly code: GoalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GoalError';
    this.statusCode = code === 'not_found' ? 404 : code === 'invalid' ? 400 : 409;
  }
}

export interface GoalServiceOptions {
  orchestrator: GoalOrchestrator;
  store: GoalStore;
  /** Workspace lock shared with the autonomous runner (not needed for dry runs). */
  lock?: WorkspaceLock;
  owner?: string;
  now?: () => Date;
}

interface ActiveGoal {
  goal: Goal;
  controller: AbortController;
  done: Promise<Goal>;
}

export class GoalService {
  private active: ActiveGoal | undefined;
  private readonly owner: string;
  private readonly now: () => Date;

  constructor(private readonly options: GoalServiceOptions) {
    this.owner = options.owner ?? 'goal';
    this.now = options.now ?? (() => new Date());
  }

  get activeGoalId(): string | undefined {
    return this.active?.goal.id;
  }

  /** Validates, persists and starts a goal in the background. Resolves with its initial state. */
  async start(input: NewGoalInput): Promise<Goal> {
    if (!input.objective.trim()) throw new GoalError('invalid', 'the objective is empty');
    if (this.active) {
      throw new GoalError('busy', `goal ${this.active.goal.id} is still running; cancel it first`);
    }
    const lock = input.dryRun ? undefined : this.options.lock;
    if (lock && !lock.acquire(this.owner)) {
      throw new GoalError(
        'busy',
        `the working tree is busy (${lock.holder ?? 'another task'} is running)`,
      );
    }
    try {
      const goal = this.options.orchestrator.create(input);
      await this.options.store.save(goal);
      const controller = new AbortController();
      const done = this.options.orchestrator
        .run(goal, controller.signal)
        .catch((err: unknown) => {
          goal.status = 'failed';
          goal.lastError = err instanceof Error ? err.message : String(err);
          return goal;
        })
        .finally(() => {
          if (this.active?.goal === goal) this.active = undefined;
          lock?.release(this.owner);
        });
      this.active = { goal, controller, done };
      return structuredClone(goal);
    } catch (err) {
      lock?.release(this.owner);
      throw err;
    }
  }

  async get(id: string): Promise<Goal | undefined> {
    if (this.active?.goal.id === id) return structuredClone(this.active.goal);
    return this.options.store.load(id);
  }

  /** Every goal of the workspace, newest first. */
  async list(): Promise<Goal[]> {
    const stored = await this.options.store.list();
    const active = this.active?.goal;
    if (!active) return stored;
    const rest = stored.filter((g) => g.id !== active.id);
    return [structuredClone(active), ...rest];
  }

  /**
   * Cancels a running goal and resolves once it has stopped. A goal left unfinished by an earlier
   * process is marked cancelled; a finished goal is returned unchanged.
   */
  async cancel(id: string): Promise<Goal> {
    if (this.active?.goal.id === id) {
      this.active.controller.abort();
      return structuredClone(await this.active.done);
    }
    const goal = await this.options.store.load(id);
    if (!goal) throw new GoalError('not_found', `unknown goal "${id}"`);
    if (isTerminalGoal(goal)) return goal;
    const stamp = this.now().toISOString();
    goal.status = 'cancelled';
    goal.updatedAt = stamp;
    goal.finishedAt = stamp;
    delete goal.activeTaskId;
    await this.options.store.save(goal);
    return goal;
  }

  /** Resolves when the goal is finished (immediately for stored goals). */
  async wait(id: string): Promise<Goal | undefined> {
    if (this.active?.goal.id === id) return structuredClone(await this.active.done);
    return this.options.store.load(id);
  }
}
