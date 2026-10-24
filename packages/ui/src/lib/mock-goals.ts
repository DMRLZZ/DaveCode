import { ApiError } from './api';
import type {
  DaveEvent,
  Goal,
  GoalArtifact,
  GoalRole,
  GoalStart,
  GoalStatus,
  GoalTask,
  LogLevel,
} from './types';

/**
 * Goal mode for the in-browser mock: a planner proposes a small task graph, role agents work
 * through it (one task every couple of seconds), and a reviewer closes the goal. Emits the same
 * `goal.updated` / `goal.log` events as the gateway.
 */

type EventInput = DaveEvent extends infer E
  ? E extends DaveEvent
    ? Omit<E, 'ts'> & { ts?: number }
    : never
  : never;

export interface MockGoalHost {
  now(): number;
  emit(event: EventInput): void;
  later(ms: number, fn: () => void): void;
  nextId(prefix: string): string;
}

const TERMINAL: ReadonlySet<GoalStatus> = new Set([
  'planned',
  'succeeded',
  'failed',
  'cancelled',
  'budget_exhausted',
]);

const ROLES: GoalRole[] = [
  { id: 'planner', description: 'Breaks the objective into a plan and success criteria.' },
  { id: 'researcher', description: 'Analyses markets, users, competitors and options.' },
  { id: 'implementer', description: 'Writes and changes code (through the autonomous runner).' },
  { id: 'reviewer', description: 'Critically reviews other outputs for gaps and risks.' },
  { id: 'writer', description: 'Positioning, marketing copy, docs and drafts of messages.' },
];

const LIMITS = { maxRounds: 4, maxTasks: 12, maxTokens: 1_000_000 };
const STEP_MS = 1_800;

type PlannedTask = Pick<GoalTask, 'id' | 'title' | 'role' | 'kind' | 'dependsOn'>;

function planFor(objective: string): PlannedTask[] {
  const code = /\b(page|site|app|api|endpoint|feature|build|implement|code)\b/i.test(objective);
  const tasks: PlannedTask[] = [
    {
      id: 'research',
      title: 'Map the audience and alternatives',
      role: 'researcher',
      kind: 'artifact',
      dependsOn: [],
    },
    {
      id: 'positioning',
      title: 'Write the positioning and key messages',
      role: 'writer',
      kind: 'artifact',
      dependsOn: ['research'],
    },
  ];
  if (code) {
    tasks.push({
      id: 'implement',
      title: 'Implement the change behind the objective',
      role: 'implementer',
      kind: 'code',
      dependsOn: ['positioning'],
    });
  }
  tasks.push(
    {
      id: 'launch-copy',
      title: 'Write the launch copy',
      role: 'writer',
      kind: 'artifact',
      dependsOn: ['positioning'],
    },
    {
      id: 'outreach',
      title: 'Draft: Email the first 20 prospects',
      role: 'writer',
      kind: 'artifact',
      dependsOn: ['launch-copy'],
    },
  );
  return tasks;
}

export class MockGoals {
  private list: Goal[] = [];

  constructor(private readonly host: MockGoalHost) {}

  /** A finished goal so the page is not empty on first load. */
  seed(t0: number): void {
    const at = (minutesAgo: number) => new Date(t0 - minutesAgo * 60_000).toISOString();
    const id = 'goal_5e1d0c2a9b77';
    const tasks: GoalTask[] = planFor('Prepare the v0.2 launch messaging').map((t) => ({
      ...t,
      status: 'SUCCESS',
      round: 1,
      attempts: 1,
      artifact: `.davecode/goals/${id}/${t.id}.md`,
      notes: `Wrote .davecode/goals/${id}/${t.id}.md`,
      ...(t.id === 'outreach' ? { description: 'DaveCode never performs outbound actions.' } : {}),
    }));
    this.list.push({
      id,
      objective: 'Prepare the v0.2 launch messaging',
      status: 'succeeded',
      round: 1,
      limits: { ...LIMITS, tokensUsed: 38_420 },
      roles: ROLES,
      tasks,
      summary:
        'Positioning, launch copy and a prospect email draft are ready in `.davecode/goals/`. A human still has to review and send the email.',
      createdAt: at(140),
      updatedAt: at(118),
      finishedAt: at(118),
    });
  }

  all(): Goal[] {
    return [...this.list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  start(body: GoalStart): Goal {
    const objective = body.objective?.trim() ?? '';
    if (!objective) throw new ApiError(400, 'invalid_body', 'objective: must not be empty');
    const running = this.list.find((g) => !TERMINAL.has(g.status));
    if (running) {
      throw new ApiError(409, 'busy', `goal ${running.id} is still running; cancel it first`);
    }
    const stamp = new Date(this.host.now()).toISOString();
    const goal: Goal = {
      id: this.host.nextId('goal'),
      objective,
      status: 'planning',
      round: 1,
      limits: {
        maxRounds: Math.min(body.maxRounds ?? LIMITS.maxRounds, LIMITS.maxRounds),
        maxTasks: Math.min(body.maxTasks ?? LIMITS.maxTasks, LIMITS.maxTasks),
        maxTokens: Math.min(body.maxTokens ?? LIMITS.maxTokens, LIMITS.maxTokens),
        tokensUsed: 0,
      },
      roles: ROLES,
      tasks: [],
      createdAt: stamp,
      updatedAt: stamp,
      ...(body.dryRun ? { dryRun: true } : {}),
    };
    this.list.push(goal);
    this.update(goal);
    this.log(goal, 'info', `planning: ${objective}`, 'planner');
    this.host.later(STEP_MS, () => this.plan(goal));
    return goal;
  }

  cancel(id: string): Goal {
    const goal = this.list.find((g) => g.id === id);
    if (!goal) throw new ApiError(404, 'not_found', `unknown goal "${id}"`);
    if (TERMINAL.has(goal.status)) return goal;
    for (const t of goal.tasks) if (t.status === 'IN_PROGRESS') t.status = 'PENDING';
    this.finish(goal, 'cancelled');
    return goal;
  }

  execute(id: string): Goal {
    const running = this.list.find((g) => !TERMINAL.has(g.status));
    if (running) {
      throw new ApiError(409, 'busy', `goal ${running.id} is still running; cancel it first`);
    }
    const goal = this.list.find((g) => g.id === id);
    if (!goal) throw new ApiError(404, 'not_found', `unknown goal "${id}"`);
    if (goal.status !== 'planned') {
      throw new ApiError(
        400,
        'invalid',
        `goal "${id}" is ${goal.status}; only a planned goal can be executed`,
      );
    }
    delete goal.dryRun;
    delete goal.finishedAt;
    delete goal.lastError;
    goal.status = 'running';
    this.update(goal);
    this.log(goal, 'info', `executing planned goal (${goal.tasks.length} task(s))`, 'planner');
    this.host.later(STEP_MS, () => this.step(goal));
    return goal;
  }

  artifact(id: string, taskId: string): GoalArtifact {
    const goal = this.list.find((g) => g.id === id);
    if (!goal) throw new ApiError(404, 'not_found', `unknown goal "${id}"`);
    const task = goal.tasks.find((t) => t.id === taskId);
    if (!task?.artifact) {
      throw new ApiError(404, 'not_found', `task "${taskId}" has no artifact in goal "${id}"`);
    }
    return {
      taskId: task.id,
      path: task.artifact,
      content: [
        `# ${task.title}`,
        '',
        `- **Goal:** ${goal.objective}`,
        `- **Role:** \`${task.role}\` (round ${task.round})`,
        '',
        '## Summary',
        '',
        task.id === 'outreach'
          ? 'Draft email prepared for human review. DaveCode never sends outbound messages or takes external actions automatically.'
          : `Completed deliverable for **${task.title.toLowerCase()}** based on repository state and quota-aware routing.`,
      ].join('\n'),
    };
  }

  // -- simulation ---------------------------------------------------------------

  private plan(goal: Goal): void {
    if (TERMINAL.has(goal.status)) return;
    goal.tasks = planFor(goal.objective)
      .slice(0, goal.limits.maxTasks)
      .map((t) => ({ ...t, status: 'PENDING', round: 1, attempts: 0 }));
    goal.summary = `${goal.tasks.length} tasks: research first, then positioning and copy; outbound steps stay drafts.`;
    this.spend(goal, 2_400);
    this.log(goal, 'info', `planned ${goal.tasks.length} task(s)`, 'planner');
    if (goal.dryRun) {
      this.finish(goal, 'planned');
      return;
    }
    goal.status = 'running';
    this.update(goal);
    this.host.later(STEP_MS, () => this.step(goal));
  }

  private step(goal: Goal): void {
    if (TERMINAL.has(goal.status)) return;
    const active = goal.tasks.find((t) => t.status === 'IN_PROGRESS');
    if (active) {
      active.status = 'SUCCESS';
      if (active.kind === 'code') {
        active.runnerTaskId = `goal-${goal.id.slice(-6)}-${active.id}`;
        active.notes = 'Merged into main after lint, typecheck and tests passed.';
      } else {
        active.artifact = `.davecode/goals/${goal.id}/${active.id}.md`;
        active.notes = `Wrote ${active.artifact}`;
      }
      delete goal.activeTaskId;
      this.spend(goal, active.kind === 'code' ? 42_000 : 5_000 + Math.round(Math.random() * 4_000));
      this.log(goal, 'info', `${active.id}: SUCCESS`, active.role, active.id);
    }
    const done = new Set(goal.tasks.filter((t) => t.status === 'SUCCESS').map((t) => t.id));
    const next = goal.tasks.find(
      (t) => t.status === 'PENDING' && t.dependsOn.every((d) => done.has(d)),
    );
    if (next) {
      next.status = 'IN_PROGRESS';
      next.attempts += 1;
      goal.activeTaskId = next.id;
      this.update(goal);
      this.log(goal, 'info', `${next.title} (attempt ${next.attempts})`, next.role, next.id);
      this.host.later(next.kind === 'code' ? STEP_MS * 3 : STEP_MS, () => this.step(goal));
      return;
    }
    goal.status = 'reviewing';
    this.update(goal);
    this.log(goal, 'info', `reviewing round ${goal.round}`, 'reviewer');
    this.host.later(STEP_MS, () => {
      if (TERMINAL.has(goal.status)) return;
      this.spend(goal, 3_100);
      goal.summary =
        'Every task succeeded. The outreach email is a draft in the goal folder: review it and send it yourself.';
      this.finish(goal, 'succeeded');
    });
  }

  // -- bookkeeping --------------------------------------------------------------

  private spend(goal: Goal, tokens: number): void {
    goal.limits.tokensUsed += tokens;
  }

  private finish(goal: Goal, status: GoalStatus): void {
    delete goal.activeTaskId;
    goal.status = status;
    goal.finishedAt = new Date(this.host.now()).toISOString();
    this.update(goal);
    this.log(
      goal,
      status === 'succeeded' || status === 'planned' ? 'info' : 'warn',
      `goal ${status} (${goal.limits.tokensUsed} tokens)`,
    );
  }

  private update(goal: Goal): void {
    goal.updatedAt = new Date(this.host.now()).toISOString();
    this.host.emit({ type: 'goal.updated', goal: structuredClone(goal) });
  }

  private log(goal: Goal, level: LogLevel, message: string, role?: string, taskId?: string): void {
    this.host.emit({
      type: 'goal.log',
      goalId: goal.id,
      level,
      message,
      ...(role ? { role } : {}),
      ...(taskId ? { taskId } : {}),
    });
  }
}
