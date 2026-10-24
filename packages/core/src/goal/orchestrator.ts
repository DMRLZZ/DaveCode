/**
 * Goal mode: a planner decomposes an objective into a task graph, role agents execute the ready
 * tasks (artifacts through the router, code through the autonomous runner), a reviewer judges the
 * results and re-plans. Bounded by rounds, a task cap and a token budget; cancellable; never takes
 * outbound actions (see `applySafetyGuard`).
 */
import type { z } from 'zod';
import { routeModel } from '../autonomous/executor';
import { extractJsonObject } from '../autonomous/judge';
import { truncateHead } from '../autonomous/process';
import { READ_ONLY_TOOL_DEFINITIONS, WorkspaceTools } from '../autonomous/tools';
import type { EventBus } from '../events';
import { countTextTokens } from '../rate-limiter/tokens';
import { RouterError } from '../router/errors';
import type { Router } from '../router/router';
import { newId } from '../storage/ids';
import type { ChatMessage, Goal, GoalStatus, GoalTask, LogLevel } from '../types';
import {
  type GoalConfig,
  normalizeTasks,
  type Plan,
  plannerPrompt,
  planSchema,
  publicRoles,
  REVIEWER_PROMPT,
  type ResolvedRole,
  type Review,
  resolveRoles,
  reviewSchema,
  roleSystemPrompt,
} from './plan';
import type { GoalStore } from './store';

export interface CodeTaskResult {
  ok: boolean;
  summary: string;
  /** Tokens the runner spent on the task. */
  tokens: number;
  /** Project task-graph id the runner worked on. */
  runnerTaskId?: string;
  /** Interrupted by cancellation. */
  stopped?: boolean;
}

/** Hands `code` tasks to the autonomous runner (see `RunnerCodeTasks`). */
export interface CodeTaskRunner {
  /** Whether code tasks can run at all (git repo, clean tree…) and why not. */
  available(): Promise<{ ok: true } | { ok: false; reason: string }>;
  run(
    task: GoalTask,
    opts: { goal: Goal; maxTokens: number; signal: AbortSignal },
  ): Promise<CodeTaskResult>;
}

export interface GoalOrchestratorOptions {
  router: Pick<Router, 'complete'>;
  store: GoalStore;
  events: EventBus;
  config: GoalConfig;
  codeRunner?: CodeTaskRunner;
  /** Attach read-only repository tools (`list_dir`, `read_file`, `search`) to agent calls. */
  readTools?: boolean;
  /** Compact budget summary (remaining quota per account) shown to every agent. */
  budgetContext?: () => string | Promise<string>;
  /** Project architecture/state summary shown to the planner and reviewer. */
  projectContext?: () => string | Promise<string>;
  now?: () => Date;
}

export interface NewGoalInput {
  objective: string;
  maxRounds?: number;
  maxTasks?: number;
  maxTokens?: number;
  /** Plan only. */
  dryRun?: boolean;
}

const TERMINAL: ReadonlySet<GoalStatus> = new Set([
  'planned',
  'succeeded',
  'failed',
  'cancelled',
  'budget_exhausted',
]);

export function isTerminalGoal(goal: Pick<Goal, 'status'>): boolean {
  return TERMINAL.has(goal.status);
}

class Cancelled extends Error {}
class OutOfBudget extends Error {}

const MAX_DEP_CHARS = 6_000;
const MAX_DEPS_TOTAL = 20_000;
const MAX_REVIEW_EXCERPT = 1_500;
const MAX_TOOL_ROUNDS = 6;

export class GoalOrchestrator {
  private readonly now: () => Date;
  private readonly tools: WorkspaceTools;

  constructor(private readonly options: GoalOrchestratorOptions) {
    this.now = options.now ?? (() => new Date());
    this.tools = new WorkspaceTools({ root: options.store.root, readOnly: true });
  }

  /** A fresh goal (not yet persisted) with limits clamped to the config. */
  create(input: NewGoalInput): Goal {
    const cfg = this.options.config;
    const stamp = this.now().toISOString();
    const goal: Goal = {
      id: newId('goal', 6),
      objective: input.objective.trim(),
      status: 'planning',
      round: 0,
      limits: {
        maxRounds: Math.min(input.maxRounds ?? cfg.maxRounds, cfg.maxRounds),
        maxTasks: Math.min(input.maxTasks ?? cfg.maxTasks, cfg.maxTasks),
        maxTokens: Math.min(input.maxTokens ?? cfg.maxTokens, cfg.maxTokens),
        tokensUsed: 0,
      },
      roles: publicRoles(resolveRoles(cfg)),
      tasks: [],
      createdAt: stamp,
      updatedAt: stamp,
    };
    if (input.dryRun) goal.dryRun = true;
    return goal;
  }

  /** Runs `goal` to a terminal status. Never throws: failures end up in `status`/`lastError`. */
  async run(goal: Goal, signal: AbortSignal): Promise<Goal> {
    const cfg = this.options.config;
    const roles = resolveRoles(cfg);
    try {
      const code = await this.codeAvailability();
      if (!code.ok) this.log(goal, 'info', `code tasks disabled: ${code.reason}`);

      if (goal.round === 0 || goal.tasks.length === 0) {
        goal.round = 1;
        await this.update(goal, { status: 'planning' });
        this.log(goal, 'info', `planning: ${goal.objective}`, 'planner');
        const plan = await this.plan(goal, roles, code.ok, signal);
        goal.tasks = normalizeTasks(plan.tasks, {
          existing: [],
          roles,
          round: 1,
          room: goal.limits.maxTasks,
          codeTasks: code.ok,
        });
        if (plan.summary) goal.summary = plan.summary;
        this.log(goal, 'info', `planned ${goal.tasks.length} task(s)`, 'planner');
        if (goal.dryRun) return await this.finish(goal, 'planned');
      } else {
        this.log(goal, 'info', `executing planned goal (${goal.tasks.length} task(s))`, 'planner');
      }

      for (;;) {
        await this.update(goal, { status: 'running' });
        await this.executeReady(goal, roles, signal);

        await this.update(goal, { status: 'reviewing' });
        this.log(goal, 'info', `reviewing round ${goal.round}`, 'reviewer');
        const review = await this.review(goal, roles, signal);
        goal.summary = review.summary;
        if (review.done) return await this.finish(goal, 'succeeded');
        if (goal.round >= goal.limits.maxRounds) {
          goal.lastError = `reached ${goal.limits.maxRounds} round(s) without completing the objective`;
          return await this.finish(goal, 'failed');
        }

        const retried = this.applyRetries(goal, review.retry);
        const added = normalizeTasks(review.tasks, {
          existing: goal.tasks,
          roles,
          round: goal.round + 1,
          room: goal.limits.maxTasks - goal.tasks.length,
          codeTasks: code.ok,
        });
        if (retried === 0 && added.length === 0) {
          goal.lastError =
            goal.tasks.length >= goal.limits.maxTasks
              ? `reached the cap of ${goal.limits.maxTasks} task(s) without completing the objective`
              : 'the reviewer proposed no further work but the objective is not done';
          return await this.finish(goal, 'failed');
        }
        goal.tasks.push(...added);
        goal.round++;
        this.log(
          goal,
          'info',
          `round ${goal.round}: ${added.length} new task(s), ${retried} retried`,
          'reviewer',
        );
      }
    } catch (err) {
      for (const task of goal.tasks) if (task.status === 'IN_PROGRESS') task.status = 'PENDING';
      delete goal.activeTaskId;
      if (err instanceof Cancelled || signal.aborted) return await this.finish(goal, 'cancelled');
      if (err instanceof OutOfBudget) {
        goal.lastError = err.message;
        return await this.finish(goal, 'budget_exhausted');
      }
      goal.lastError = err instanceof Error ? err.message : String(err);
      this.log(goal, 'error', goal.lastError);
      return await this.finish(goal, 'failed');
    }
  }

  // -- phases -----------------------------------------------------------------

  private async codeAvailability(): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.options.config.codeTasks) return { ok: false, reason: 'goal.codeTasks is off' };
    if (!this.options.codeRunner) return { ok: false, reason: 'no project runner available' };
    try {
      return await this.options.codeRunner.available();
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  private async plan(
    goal: Goal,
    roles: readonly ResolvedRole[],
    codeTasks: boolean,
    signal: AbortSignal,
  ): Promise<Plan> {
    const user = [
      `OBJECTIVE:\n${goal.objective}`,
      `You may plan at most ${goal.limits.maxTasks} task(s) in total; the team has ${goal.limits.maxRounds} round(s) of plan → execute → review.`,
      await this.sharedContext(),
    ]
      .filter(Boolean)
      .join('\n\n');
    return this.askJson(
      planSchema,
      goal,
      this.roleFor(roles, 'planner'),
      plannerPrompt(roles, codeTasks),
      user,
      signal,
    );
  }

  private async review(
    goal: Goal,
    roles: readonly ResolvedRole[],
    signal: AbortSignal,
  ): Promise<Review> {
    const lines: string[] = [];
    for (const task of goal.tasks) {
      lines.push(
        `- [${task.status}] ${task.id} (${task.role}, ${task.kind}, round ${task.round}, ${task.attempts} attempt(s)): ${task.title}`,
      );
      if (task.notes) lines.push(`  notes: ${truncateHead(task.notes, 500).replace(/\n/g, ' ')}`);
      if (task.artifact) {
        const text = await this.options.store.readArtifact(goal.id, task.id);
        if (text)
          lines.push(`  output excerpt:\n${indent(truncateHead(text, MAX_REVIEW_EXCERPT))}`);
      }
    }
    const user = [
      `OBJECTIVE:\n${goal.objective}`,
      `Round ${goal.round} of ${goal.limits.maxRounds}. Room for ${Math.max(0, goal.limits.maxTasks - goal.tasks.length)} more task(s).`,
      `TASKS:\n${lines.join('\n')}`,
      await this.sharedContext(),
    ]
      .filter(Boolean)
      .join('\n\n');
    return this.askJson(
      reviewSchema,
      goal,
      this.roleFor(roles, 'reviewer'),
      REVIEWER_PROMPT,
      user,
      signal,
    );
  }

  /** Runs ready tasks until none is left; failed tasks are retried up to `maxTaskAttempts`. */
  private async executeReady(
    goal: Goal,
    roles: readonly ResolvedRole[],
    signal: AbortSignal,
  ): Promise<void> {
    for (;;) {
      const task = readyGoalTasks(goal)[0];
      if (!task) return;
      this.checkpoint(goal, signal);
      task.attempts++;
      task.status = 'IN_PROGRESS';
      await this.update(goal, { activeTaskId: task.id });
      this.log(goal, 'info', `${task.title} (attempt ${task.attempts})`, task.role, task.id);
      try {
        if (task.kind === 'code') await this.runCodeTask(goal, task, signal);
        else await this.runArtifactTask(goal, task, this.roleFor(roles, task.role), signal);
        // runCodeTask/runArtifactTask set the outcome; re-read it past the narrowing above.
        const outcome = (task as GoalTask).status;
        this.log(
          goal,
          outcome === 'SUCCESS' ? 'info' : 'warn',
          `${task.id}: ${outcome}`,
          task.role,
          task.id,
        );
      } catch (err) {
        if (err instanceof Cancelled || err instanceof OutOfBudget || signal.aborted) throw err;
        if (
          err instanceof RouterError &&
          (err.code === 'no_capacity' || err.code === 'rate_limited')
        ) {
          throw new OutOfBudget(`no account has capacity left (${err.message})`);
        }
        task.status = 'FAILED';
        task.notes = truncateHead(err instanceof Error ? err.message : String(err), 2_000);
        this.log(goal, 'warn', `${task.id} failed: ${task.notes}`, task.role, task.id);
      }
      if (task.status === 'FAILED' && task.attempts < this.options.config.maxTaskAttempts) {
        task.status = 'PENDING';
      }
      delete goal.activeTaskId;
      await this.update(goal, {});
    }
  }

  private async runArtifactTask(
    goal: Goal,
    task: GoalTask,
    role: ResolvedRole,
    signal: AbortSignal,
  ): Promise<void> {
    const parts = [`OBJECTIVE OF THE TEAM:\n${goal.objective}`, `YOUR TASK: ${task.title}`];
    if (task.description) parts.push(task.description);
    if (task.acceptance?.length) {
      parts.push(`Acceptance criteria:\n${task.acceptance.map((c) => `- ${c}`).join('\n')}`);
    }
    let budget = MAX_DEPS_TOTAL;
    for (const depId of task.dependsOn) {
      const dep = goal.tasks.find((t) => t.id === depId);
      if (!dep || budget <= 0) continue;
      const text = dep.artifact
        ? await this.options.store.readArtifact(goal.id, dep.id)
        : dep.notes;
      if (!text) continue;
      const excerpt = truncateHead(text, Math.min(MAX_DEP_CHARS, budget));
      budget -= excerpt.length;
      parts.push(`OUTPUT OF ${dep.id} (${dep.role}): ${dep.title}\n${excerpt}`);
    }
    const shared = await this.sharedContext(false);
    if (shared) parts.push(shared);

    const reply = (
      await this.ask(goal, role, roleSystemPrompt(role), parts.join('\n\n'), signal)
    ).trim();
    if (!reply) throw new Error('the agent returned an empty reply');
    task.artifact = await this.options.store.writeArtifact(goal.id, task.id, stripFence(reply));
    task.status = 'SUCCESS';
    task.notes = `Wrote ${task.artifact}`;
  }

  private async runCodeTask(goal: Goal, task: GoalTask, signal: AbortSignal): Promise<void> {
    const runner = this.options.codeRunner;
    if (!runner) throw new Error('no project runner available for code tasks');
    const result = await runner.run(task, {
      goal,
      maxTokens: goal.limits.maxTokens - goal.limits.tokensUsed,
      signal,
    });
    this.addTokens(goal, result.tokens);
    if (result.runnerTaskId) task.runnerTaskId = result.runnerTaskId;
    if (result.stopped || signal.aborted) throw new Cancelled();
    task.status = result.ok ? 'SUCCESS' : 'FAILED';
    task.notes = truncateHead(result.summary || (result.ok ? 'done' : 'failed'), 2_000);
  }

  private applyRetries(goal: Goal, ids: readonly string[]): number {
    let count = 0;
    for (const id of new Set(ids)) {
      const task = goal.tasks.find((t) => t.id === id);
      if (task?.status !== 'FAILED') continue;
      task.status = 'PENDING';
      task.attempts = 0;
      count++;
    }
    return count;
  }

  // -- model calls ------------------------------------------------------------

  private roleFor(roles: readonly ResolvedRole[], id: string): ResolvedRole {
    return roles.find((r) => r.id === id) ?? { id, description: id, kind: 'artifact' };
  }

  private async ask(
    goal: Goal,
    role: ResolvedRole,
    system: string,
    user: string,
    signal: AbortSignal,
  ): Promise<string> {
    const model = routeModel(role.route ?? this.options.config.route);
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    let attachTools = this.options.readTools === true;
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      this.checkpoint(goal, signal);
      const allowTools = attachTools && round < MAX_TOOL_ROUNDS;
      let completion: Awaited<ReturnType<typeof this.options.router.complete>>['completion'];
      try {
        ({ completion } = await this.options.router.complete(
          {
            model,
            messages,
            ...(allowTools ? { tools: [...READ_ONLY_TOOL_DEFINITIONS] } : {}),
          },
          { signal },
        ));
      } catch (err) {
        if (allowTools && err instanceof RouterError && err.code === 'no_available_account') {
          attachTools = false;
          ({ completion } = await this.options.router.complete({ model, messages }, { signal }));
        } else {
          throw err;
        }
      }
      const message = completion.choices[0]?.message;
      const content = message?.content;
      const text = typeof content === 'string' ? content : '';
      const usage = completion.usage;
      this.addTokens(
        goal,
        usage && usage.prompt_tokens + usage.completion_tokens > 0
          ? usage.prompt_tokens + usage.completion_tokens
          : countTextTokens(system) + countTextTokens(user) + countTextTokens(text),
      );
      const calls = message?.tool_calls ?? [];
      if (calls.length === 0 || round === MAX_TOOL_ROUNDS) return text;
      messages.push({ role: 'assistant', content: content ?? null, tool_calls: calls });
      for (const call of calls) {
        this.log(goal, 'debug', `tool ${call.function.name}`, role.id, goal.activeTaskId);
        const outcome = await this.tools.call(call.function.name, call.function.arguments, signal);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: outcome.output,
        });
      }
    }
    return '';
  }

  /** Asks for a JSON reply matching `schema`; one corrective retry on malformed output. */
  private async askJson<T>(
    schema: z.ZodType<T>,
    goal: Goal,
    role: ResolvedRole,
    system: string,
    user: string,
    signal: AbortSignal,
  ): Promise<T> {
    let problem = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt =
        attempt === 0
          ? user
          : `${user}\n\nYour previous reply was rejected (${problem}). Respond with ONLY the JSON object in the required shape.`;
      const reply = await this.ask(goal, role, system, prompt, signal);
      try {
        const parsed = schema.safeParse(extractJsonObject(reply));
        if (parsed.success) return parsed.data;
        problem = parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.') || 'reply'}: ${i.message}`)
          .join('; ');
      } catch (err) {
        problem = err instanceof Error ? err.message : String(err);
      }
      this.log(goal, 'warn', `invalid JSON from the ${role.id}: ${problem}`, role.id);
    }
    throw new Error(`the ${role.id} did not return valid JSON (${problem})`);
  }

  private async sharedContext(includeProject = true): Promise<string> {
    const parts: string[] = [];
    if (includeProject && this.options.projectContext) {
      const project = (await this.options.projectContext()).trim();
      if (project) parts.push(`PROJECT CONTEXT:\n${project}`);
    }
    if (this.options.budgetContext) {
      const budget = (await this.options.budgetContext()).trim();
      if (budget) parts.push(budget);
    }
    return parts.join('\n\n');
  }

  // -- bookkeeping ------------------------------------------------------------

  private checkpoint(goal: Goal, signal: AbortSignal): void {
    if (signal.aborted) throw new Cancelled();
    if (goal.limits.tokensUsed >= goal.limits.maxTokens) {
      throw new OutOfBudget(
        `token budget exhausted (${goal.limits.tokensUsed}/${goal.limits.maxTokens})`,
      );
    }
  }

  private addTokens(goal: Goal, tokens: number): void {
    if (Number.isFinite(tokens) && tokens > 0) goal.limits.tokensUsed += Math.round(tokens);
  }

  private async update(
    goal: Goal,
    patch: Partial<Pick<Goal, 'status' | 'activeTaskId'>>,
  ): Promise<void> {
    Object.assign(goal, patch);
    goal.updatedAt = this.now().toISOString();
    await this.options.store.save(goal);
    this.options.events.emit({ type: 'goal.updated', goal: structuredClone(goal) });
  }

  private async finish(goal: Goal, status: GoalStatus): Promise<Goal> {
    delete goal.activeTaskId;
    goal.finishedAt = this.now().toISOString();
    await this.update(goal, { status });
    this.log(
      goal,
      status === 'succeeded' || status === 'planned' ? 'info' : 'warn',
      `goal ${status}${goal.lastError ? `: ${goal.lastError}` : ''} (${goal.limits.tokensUsed} tokens)`,
    );
    return goal;
  }

  private log(goal: Goal, level: LogLevel, message: string, role?: string, taskId?: string): void {
    this.options.events.emit({
      type: 'goal.log',
      goalId: goal.id,
      level,
      message,
      ...(role ? { role } : {}),
      ...(taskId ? { taskId } : {}),
    });
  }
}

/** PENDING tasks whose dependencies all succeeded, in plan order. */
export function readyGoalTasks(goal: Pick<Goal, 'tasks'>): GoalTask[] {
  const status = new Map(goal.tasks.map((t) => [t.id, t.status]));
  return goal.tasks.filter(
    (t) => t.status === 'PENDING' && t.dependsOn.every((d) => status.get(d) === 'SUCCESS'),
  );
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
}

/** Models sometimes wrap the whole document in a ```markdown fence. */
function stripFence(text: string): string {
  const match = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i.exec(text);
  return match?.[1] ?? text;
}
