/**
 * Pane orchestrator planning: the prompts the planner and the task agents receive, and the
 * validation that turns the planner's JSON reply into a safe, acyclic list of tasks.
 */
import { z } from 'zod';
import { extractJsonObject } from '../autonomous/judge';
import {
  ORCHESTRATOR_AGENTS,
  ORCHESTRATOR_LIMITS,
  type OrchestratorAgent,
  type OrchestratorTask,
} from './contract';

/** One line per agent, shown to the planner so it can pick who does what. */
export const AGENT_DESCRIPTIONS: Record<OrchestratorAgent, string> = {
  claude:
    'Claude Code (Anthropic): careful multi-file changes, refactors and reasoning about existing code.',
  codex: 'Codex CLI (OpenAI): focused implementation work, scripts, tests and quick fixes.',
  agy: 'Antigravity (Google): broad feature work, front-end and UI changes, exploratory tasks.',
};

const TITLE_MAX_LENGTH = 120;
const PROMPT_MAX_LENGTH = 8000;
/** Longest piece of a previous reply quoted back to the planner in the repair prompt. */
const REPAIR_REPLY_MAX_LENGTH = 6000;

/** The first allowed agent in the fixed order claude, codex, agy. */
export function pickPlanner(agents: readonly OrchestratorAgent[]): OrchestratorAgent | undefined {
  return ORCHESTRATOR_AGENTS.find((agent) => agents.includes(agent));
}

const REPLY_SHAPE =
  '{"tasks":[{"title":string,"agent":"claude"|"codex"|"agy","prompt":string,"dependsOn":[number]}]}';

export interface PlanPromptInput {
  objective: string;
  agents: readonly OrchestratorAgent[];
  maxTasks: number;
}

export function buildPlanPrompt(input: PlanPromptInput): string {
  const agentLines = input.agents.map((agent) => `- ${agent}: ${AGENT_DESCRIPTIONS[agent]}`);
  return [
    'You are the planner of DaveCode, which splits one objective across several coding agents.',
    'Do not change any file. Read the repository as much as you need, then answer with a plan.',
    '',
    'Objective:',
    input.objective,
    '',
    'Agents you may assign tasks to:',
    ...agentLines,
    '',
    'Rules:',
    `- Use at most ${input.maxTasks} task${input.maxTasks === 1 ? '' : 's'}. Fewer is better when the objective is small.`,
    '- Tasks run in parallel, each in its own separate copy of the repository, and their changes are merged afterwards. Give tasks different files to touch wherever possible so the merges do not conflict.',
    '- When a task needs the result of another task, list it in "dependsOn" (1-based positions in the "tasks" array). It then starts only after those tasks finished and were merged.',
    '- Each "prompt" must be self-contained: the agent sees only its own prompt and the repository, not this plan or the other prompts. Say exactly what to build or change, where, and how to know it is done.',
    '- Spread the work over the agents according to their strengths.',
    '',
    'Reply with ONLY a JSON object, no prose and no code fence, of this shape:',
    REPLY_SHAPE,
  ].join('\n');
}

/** Second chance after an unusable reply: the previous answer plus why it was rejected. */
export function buildRepairPrompt(
  input: PlanPromptInput,
  previousReply: string,
  error: string,
): string {
  const reply =
    previousReply.length > REPAIR_REPLY_MAX_LENGTH
      ? `${previousReply.slice(0, REPAIR_REPLY_MAX_LENGTH)}…`
      : previousReply;
  return [
    'Your previous plan could not be used.',
    `Problem: ${error}`,
    '',
    'Your previous reply:',
    reply.trim() || '(empty)',
    '',
    `Objective: ${input.objective}`,
    `Allowed agents: ${input.agents.join(', ')}. At most ${input.maxTasks} tasks, at least one.`,
    'Dependencies are 1-based task positions and must not form a cycle.',
    'Do not change any file. Reply with ONLY a JSON object of this shape:',
    REPLY_SHAPE,
  ].join('\n');
}

export interface TaskPromptInput {
  objective: string;
  task: Pick<OrchestratorTask, 'id' | 'title' | 'prompt' | 'dependsOn'>;
  /** Every task of the plan, used to describe the parallel work and the dependencies. */
  tasks: ReadonlyArray<Pick<OrchestratorTask, 'id' | 'title' | 'agent'>>;
}

export function buildTaskPrompt(input: TaskPromptInput): string {
  const others = input.tasks.filter((t) => t.id !== input.task.id);
  const deps = input.tasks.filter((t) => input.task.dependsOn.includes(t.id));
  const lines = [
    'You are one of several coding agents working together on one objective, coordinated by DaveCode.',
    '',
    'Overall objective:',
    input.objective,
    '',
    `Your task: ${input.task.title}`,
    input.task.prompt,
    '',
  ];
  if (deps.length > 0) {
    lines.push(
      'The results of these tasks are already in your copy of the repository:',
      ...deps.map((t) => `- ${t.title}`),
      '',
    );
  }
  if (others.length > 0) {
    lines.push(
      'Other agents work on these parts in parallel, in their own copies of the repository:',
      ...others.map((t) => `- ${t.title} (${t.agent})`),
      '',
    );
  }
  lines.push(
    'Rules:',
    '- Keep to the scope of your task; leave the other parts to the other agents.',
    '- Do not commit, push, create or switch branches. DaveCode commits and merges your changes.',
    '- Do not read or modify anything under `.davecode/`.',
    '- When you are done, finish with a short summary of what you changed and anything left open.',
  );
  return lines.join('\n');
}

// --- Parsing the planner's reply --------------------------------------------------------------

const dependencySchema = z.union([z.number(), z.string()]);

const plannedTaskSchema = z.object({
  title: z.string().trim().min(1),
  agent: z.string().optional(),
  prompt: z.string().trim().min(1),
  dependsOn: z.array(dependencySchema).nullish(),
});

export const planReplySchema = z.object({
  tasks: z.array(plannedTaskSchema).min(1, 'the plan has no tasks'),
});

export interface ParsePlanOptions {
  /** Allowed agents for the run (non-empty). */
  agents: readonly OrchestratorAgent[];
  maxTasks: number;
}

export type ParsePlanResult =
  | { ok: true; tasks: OrchestratorTask[] }
  | { ok: false; error: string };

/** `2`, `"2"` and `"t2"` all mean the second task. */
function dependencyIndex(value: number | string): number | undefined {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
  const match = /^\s*t?(\d+)\s*$/i.exec(value);
  return match?.[1] ? Number(match[1]) : undefined;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function describeZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'the reply does not match the expected shape';
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${path}${issue.message}`;
}

/** Returns one cycle as `[a, b, …, a]`, or undefined when the tasks are acyclic. */
export function findCycle(tasks: ReadonlyArray<Pick<OrchestratorTask, 'id' | 'dependsOn'>>) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const done = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visit = (id: string): string[] | undefined => {
    stack.push(id);
    onStack.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (onStack.has(dep)) return [...stack.slice(stack.indexOf(dep)), dep];
      if (!done.has(dep) && byId.has(dep)) {
        const cycle = visit(dep);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    onStack.delete(id);
    done.add(id);
    return undefined;
  };
  for (const task of tasks) {
    if (done.has(task.id)) continue;
    const cycle = visit(task.id);
    if (cycle) return cycle;
  }
  return undefined;
}

/**
 * Validates and normalizes a planner reply: ids `t1…tN`, at most `maxTasks` tasks, unknown or
 * disallowed agents reassigned round-robin over the allowed ones, dependencies that are out of
 * range or point at the task itself dropped. Cycles are rejected.
 */
export function parsePlan(text: string, options: ParsePlanOptions): ParsePlanResult {
  if (options.agents.length === 0) return { ok: false, error: 'no agents are allowed' };
  let raw: unknown;
  try {
    raw = extractJsonObject(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `the reply is not a valid JSON object (${clip(reason, 120)})` };
  }
  const parsed = planReplySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: describeZodError(parsed.error) };

  const maxTasks = Math.max(1, Math.min(options.maxTasks, ORCHESTRATOR_LIMITS.maxTasks));
  const planned = parsed.data.tasks.slice(0, maxTasks);
  let roundRobin = 0;
  const tasks = planned.map((p, index): OrchestratorTask => {
    const allowed = options.agents.find((a) => a === p.agent?.trim().toLowerCase());
    const agent = allowed ?? options.agents[roundRobin++ % options.agents.length]!;
    const deps = new Set<string>();
    for (const value of p.dependsOn ?? []) {
      const dep = dependencyIndex(value);
      if (dep === undefined || dep < 1 || dep > planned.length || dep === index + 1) continue;
      deps.add(`t${dep}`);
    }
    return {
      id: `t${index + 1}`,
      title: clip(p.title.replace(/\s+/g, ' '), TITLE_MAX_LENGTH),
      agent,
      prompt: clip(p.prompt, PROMPT_MAX_LENGTH),
      dependsOn: [...deps],
      status: 'pending',
    };
  });

  const cycle = findCycle(tasks);
  if (cycle) {
    return { ok: false, error: `the dependencies form a cycle (${cycle.join(' -> ')})` };
  }
  return { ok: true, tasks };
}
