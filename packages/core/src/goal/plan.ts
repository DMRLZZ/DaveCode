/**
 * Goal mode planning primitives: the role catalogue, the JSON contracts the planner and reviewer
 * must answer with (validated with zod), their prompts, and the deterministic safety guard that
 * turns any outbound action (email, posting, payments…) into a draft artifact.
 */
import { z } from 'zod';
import { findCycles } from '../brain/graph';
import type { DaveConfig } from '../config/schema';
import type { GoalRole, GoalTask, GoalTaskKind } from '../types';

export type GoalConfig = DaveConfig['goal'];

/** A role with everything the orchestrator needs to prompt it. */
export interface ResolvedRole extends GoalRole {
  kind: GoalTaskKind;
  instructions?: string;
}

export const DEFAULT_ROLES: readonly ResolvedRole[] = [
  {
    id: 'planner',
    description: 'Breaks the objective into a plan, defines milestones and success criteria.',
    kind: 'artifact',
  },
  {
    id: 'researcher',
    description:
      'Analyses markets, users, competitors and options from its own knowledge and the workspace; cannot browse the web.',
    kind: 'artifact',
  },
  {
    id: 'implementer',
    description: 'Writes and changes code in the repository (handed to the autonomous runner).',
    kind: 'code',
  },
  {
    id: 'reviewer',
    description: 'Critically reviews other outputs for gaps, risks and quality.',
    kind: 'artifact',
  },
  {
    id: 'writer',
    description:
      'Writes positioning, marketing copy, landing-page text, documentation and drafts of messages.',
    kind: 'artifact',
  },
];

/** Built-in roles merged with `goal.roles` (config entries override or add roles). */
export function resolveRoles(config: Pick<GoalConfig, 'roles'>): ResolvedRole[] {
  const roles = new Map<string, ResolvedRole>(DEFAULT_ROLES.map((r) => [r.id, { ...r }]));
  for (const [id, override] of Object.entries(config.roles)) {
    const base = roles.get(id);
    const role: ResolvedRole = {
      id,
      description: override.description ?? base?.description ?? id,
      kind: override.kind ?? base?.kind ?? 'artifact',
    };
    if (override.route) role.route = override.route;
    const instructions = override.instructions ?? base?.instructions;
    if (instructions) role.instructions = instructions;
    roles.set(id, role);
  }
  return [...roles.values()];
}

/** Public shape stored on the goal (no prompt text). */
export function publicRoles(roles: readonly ResolvedRole[]): GoalRole[] {
  return roles.map(({ id, description, route }) =>
    route ? { id, description, route } : { id, description },
  );
}

// ---------------------------------------------------------------------------
// Safety guard
// ---------------------------------------------------------------------------

/**
 * Actions that reach third parties. DaveCode never performs them: a task asking for one becomes
 * an artifact that drafts it for a human to review and execute.
 */
const OUTBOUND = [
  /\b(send|sending|email|e-mail|emailing|mail out)\b/i,
  /\b(tweet|dm|direct message|share on)\b/i,
  /\b(post|publish)\b[^.\n]{0,60}\b(on|to)\b/i,
  /\b(pay|purchase|buy|checkout|subscribe to|sign up|signup|register (for|on|at))\b/i,
  /\b(outreach|cold[- ]?(call|email)|contact (the|our|potential|prospects?|customers?|leads?))\b/i,
  /\b(launch (the )?ads?|run (the )?ads?|ad campaign|deploy to production|go live)\b/i,
];

/**
 * The subset that also disqualifies a `code` task: operating something live, as opposed to
 * writing code that could (an "email validation" feature is fine; "email the leads" is not).
 */
const OPERATIONAL = [
  /\b(deploy|release|publish)\b[^.\n]*\b(production|prod|npm|app store|play store|live)\b/i,
  /\b(go live|pay|purchase|buy|checkout)\b/i,
  /\b(send|email|e-mail|message)\b[^.\n]*\b(customers?|users?|leads?|prospects?|subscribers?|mailing list|newsletter)\b/i,
  /\b(post|tweet|publish)\b[^.\n]*\b(twitter|x\.com|linkedin|facebook|instagram|reddit|hacker news|product hunt)\b/i,
];

function firstMatch(patterns: readonly RegExp[], text: string): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return undefined;
}

/** The first outbound-action phrase found in `text`, if any. */
export function outboundAction(text: string): string | undefined {
  return firstMatch(OUTBOUND, text);
}

export const DRAFT_NOTICE =
  'DaveCode never performs outbound actions (emails, posts, payments, sign-ups, deployments). Produce a ready-to-use DRAFT for a human to review and execute.';

/**
 * Forces tasks that ask for an outbound action into draft artifacts. Artifact tasks only get
 * the draft title and notice (they can only ever write markdown); code tasks are converted when
 * they ask to operate something live. Returns a new task.
 */
export function applySafetyGuard(task: GoalTask): GoalTask {
  const text = `${task.title}\n${task.description ?? ''}`;
  const action = task.kind === 'code' ? firstMatch(OPERATIONAL, text) : firstMatch(OUTBOUND, text);
  if (!action) return task;
  const title = /^draft\b/i.test(task.title) ? task.title : `Draft: ${task.title}`;
  const description = [task.description?.trim(), DRAFT_NOTICE].filter(Boolean).join('\n\n');
  return { ...task, kind: 'artifact', title: title.slice(0, 300), description };
}

// ---------------------------------------------------------------------------
// Planner / reviewer JSON contracts
// ---------------------------------------------------------------------------

export const plannedTaskSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().trim().min(1).max(300),
  description: z.string().max(8_000).optional(),
  role: z.string().min(1).max(40),
  kind: z.enum(['code', 'artifact']).optional(),
  dependsOn: z.array(z.string().min(1)).max(50).default([]),
  acceptance: z.array(z.string().min(1).max(1_000)).max(20).optional(),
});
export type PlannedTask = z.infer<typeof plannedTaskSchema>;

export const planSchema = z.object({
  summary: z.string().max(4_000).optional(),
  tasks: z.array(plannedTaskSchema).min(1).max(100),
});
export type Plan = z.infer<typeof planSchema>;

export const reviewSchema = z.object({
  /** The objective is achieved as far as DaveCode can take it. */
  done: z.boolean(),
  summary: z.string().max(8_000),
  /** Ids of FAILED tasks worth another attempt. */
  retry: z.array(z.string()).max(50).default([]),
  /** New tasks for the next round. */
  tasks: z.array(plannedTaskSchema).max(50).default([]),
});
export type Review = z.infer<typeof reviewSchema>;

const TASK_ID = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;

/** Lowercase kebab-case id that satisfies the task-graph id rules. */
export function sanitizeTaskId(raw: string): string {
  const id = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return TASK_ID.test(id) ? id : 'task';
}

export interface NormalizeOptions {
  existing: readonly GoalTask[];
  roles: readonly ResolvedRole[];
  round: number;
  /** How many new tasks may still be added (goal.maxTasks minus existing). */
  room: number;
  /** False when code tasks cannot run: they become artifacts (implementation plans). */
  codeTasks: boolean;
}

/**
 * Turns planner output into goal tasks: unique valid ids, known roles (unknown ones fall back to
 * `implementer` for code and `writer` otherwise), dependencies restricted to known tasks, no
 * cycles, the task cap, and the safety guard.
 */
export function normalizeTasks(
  planned: readonly PlannedTask[],
  opts: NormalizeOptions,
): GoalTask[] {
  const roleById = new Map(opts.roles.map((r) => [r.id, r]));
  const taken = new Set(opts.existing.map((t) => t.id));
  const idMap = new Map<string, string>();
  const out: GoalTask[] = [];

  for (const p of planned.slice(0, Math.max(0, opts.room))) {
    let id = sanitizeTaskId(p.id);
    for (let n = 2; taken.has(id); n++) id = `${sanitizeTaskId(p.id)}-${n}`;
    taken.add(id);
    idMap.set(p.id, id);
    let role = roleById.get(p.role.toLowerCase());
    const requested: GoalTaskKind = p.kind ?? role?.kind ?? 'artifact';
    if (!role)
      role = roleById.get(requested === 'code' ? 'implementer' : 'writer') ?? opts.roles[0];
    const kind: GoalTaskKind = requested === 'code' && opts.codeTasks ? 'code' : 'artifact';
    const task: GoalTask = {
      id,
      title: p.title,
      role: role?.id ?? 'writer',
      kind,
      status: 'PENDING',
      dependsOn: p.dependsOn,
      round: opts.round,
      attempts: 0,
    };
    const description =
      requested === 'code' && kind === 'artifact'
        ? [
            p.description,
            'Code tasks cannot run here: write a precise implementation plan instead.',
          ]
            .filter(Boolean)
            .join('\n\n')
        : p.description;
    if (description) task.description = description;
    if (p.acceptance?.length) task.acceptance = p.acceptance;
    out.push(applySafetyGuard(task));
  }

  const known = new Set([...opts.existing.map((t) => t.id), ...out.map((t) => t.id)]);
  for (const task of out) {
    task.dependsOn = [
      ...new Set(task.dependsOn.map((d) => idMap.get(d) ?? sanitizeTaskId(d))),
    ].filter((d) => d !== task.id && known.has(d));
  }

  // Break any cycle among the new tasks by dropping the closing edge.
  for (;;) {
    const graph = {
      version: 1 as const,
      tasks: [...opts.existing, ...out].map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        dependsOn: t.dependsOn,
      })),
    };
    const cycle = findCycles(graph)[0];
    if (!cycle) break;
    const from = cycle[cycle.length - 2];
    const to = cycle[cycle.length - 1];
    const task = out.find((t) => t.id === from);
    if (!task) break;
    task.dependsOn = task.dependsOn.filter((d) => d !== to);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const SAFETY_RULES = `Hard rules (non-negotiable):
- You run inside DaveCode with no internet access and no ability to contact anyone.
- Never send emails or messages, post or publish anything, make payments or purchases, sign up for services, or deploy. When such a step is useful, produce a DRAFT for a human to review and execute.
- Never invent credentials, personal data or facts presented as verified; label assumptions and estimates clearly.
- Stay within the objective; prefer concrete, actionable outputs.`;

function roleList(roles: readonly ResolvedRole[]): string {
  return roles.map((r) => `- ${r.id} (${r.kind}): ${r.description}`).join('\n');
}

export function plannerPrompt(roles: readonly ResolvedRole[], codeTasks: boolean): string {
  return `You are the planner of a small team of AI agents working toward one objective. Decompose the objective into a dependency graph of concrete tasks and assign each task to one role.

Roles:
${roleList(roles)}

Task kinds:
- "artifact": the role writes one markdown document (analysis, plan, copy, checklist, draft).
- "code": the implementer changes the repository; an autonomous runner branches, runs the quality gates and merges.${codeTasks ? '' : '\n  Code tasks are NOT available in this workspace: plan artifact tasks only.'}

${SAFETY_RULES}

Plan at most the number of tasks you are allowed, smallest useful set first. Ids are short lowercase kebab-case. Use dependsOn so later tasks build on earlier outputs.

Respond with ONLY a JSON object, no prose and no code fences:
{"summary": "one paragraph plan", "tasks": [{"id": "market-research", "title": "...", "description": "...", "role": "researcher", "kind": "artifact", "dependsOn": [], "acceptance": ["..."]}]}`;
}

export const REVIEWER_PROMPT = `You are the reviewer of a team of AI agents working toward one objective. Judge the results so far against the objective.

${SAFETY_RULES}

Decide:
- "done": true when the objective is achieved as far as an offline team can take it (remaining steps are outbound actions a human must do from the drafts).
- otherwise propose the next round: "retry" lists FAILED task ids worth another attempt, "tasks" lists new tasks (same shape as the planner's, dependsOn may reference existing ids).

Respond with ONLY a JSON object, no prose and no code fences:
{"done": false, "summary": "progress, gaps and what a human must do next", "retry": [], "tasks": []}`;

export function roleSystemPrompt(role: ResolvedRole): string {
  return [
    `You are the ${role.id} of a small team of AI agents. ${role.description}`,
    SAFETY_RULES,
    'Write your deliverable as a single, well-structured markdown document. Do not wrap it in code fences. Start with a level-1 heading.',
    role.instructions?.trim(),
  ]
    .filter(Boolean)
    .join('\n\n');
}
