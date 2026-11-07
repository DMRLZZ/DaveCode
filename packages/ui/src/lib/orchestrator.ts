import { z } from 'zod';
import { ApiError } from './api';
import type {
  AgentAvailability,
  AgentOutput,
  ApiErrorBody,
  DaveEvent,
  OrchestratorAgent,
  OrchestratorRun,
  OrchestratorTask,
  StartRunInput,
} from './types';

/**
 * Pane orchestrator client: the HTTP calls under `/api/orchestrator` and the pure state the
 * terminal workspace derives from `GET /runs` plus the `orchestrator.*` events.
 */

export const ORCHESTRATOR_AGENT_IDS: readonly OrchestratorAgent[] = ['claude', 'codex', 'agy'];

/** Output lines kept per (run, task) stream; older lines are dropped. */
export const MAX_OUTPUT_LINES = 500;

/** The pseudo task id the planner's output is reported under. */
export const PLAN_TASK_ID = 'plan';

// --- Response validation ----------------------------------------------------------------------

const agentSchema = z.enum(['claude', 'codex', 'agy']);

const availabilitySchema = z.object({ agent: agentSchema, available: z.boolean() });

// Loose objects: the fields the UI relies on are checked, anything else passes through.
const taskSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  agent: agentSchema,
  status: z.enum(['pending', 'running', 'done', 'failed', 'conflict', 'cancelled', 'skipped']),
  dependsOn: z.array(z.string()).default([]),
});

const runSchema = z.looseObject({
  id: z.string(),
  objective: z.string(),
  status: z.enum(['planning', 'running', 'done', 'failed', 'cancelled']),
  agents: z.array(agentSchema).default([]),
  tasks: z.array(taskSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** A run, bare or in a `{ run }` envelope. */
const runResponseSchema = z.union([z.object({ run: runSchema }), runSchema]);

function parseRun(json: unknown): OrchestratorRun {
  const parsed = runResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError(0, 'bad_response', 'Unexpected orchestrator response.');
  }
  const run = 'run' in parsed.data ? parsed.data.run : parsed.data;
  return run as unknown as OrchestratorRun;
}

// --- HTTP -------------------------------------------------------------------------------------

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

function headers(token: string, json = false): Record<string, string> {
  return {
    Accept: 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

/** Sends a request and throws `ApiError` with the gateway's own message when it is not 2xx. */
async function call(
  base: string,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(joinUrl(base, `/api/orchestrator${path}`), {
      method,
      // State-changing requests always declare JSON, even without a body (the gateway requires it).
      headers: headers(token, method === 'POST'),
      cache: 'no-store',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    throw new ApiError(0, 'network', `Gateway unreachable: ${(e as Error).message}`);
  }
  if (response.status === 204) return undefined;
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(response.status, 'bad_response', 'Unexpected orchestrator response.');
  }
  if (!response.ok) {
    const error = (json as Partial<ApiErrorBody> | undefined)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? `http_${response.status}`,
      error?.message ?? `The orchestrator request failed (${response.status}).`,
    );
  }
  return json;
}

/**
 * Which agents the orchestrator could drive, or null when this gateway has no orchestrator
 * (404: not a project, a remote gateway, an older version) or cannot be reached.
 */
export async function fetchOrchestratorAgents(
  base: string,
  token: string,
): Promise<AgentAvailability[] | null> {
  try {
    const parsed = z
      .object({ agents: z.array(availabilitySchema) })
      .safeParse(await call(base, token, 'GET', '/agents'));
    return parsed.success ? parsed.data.agents : null;
  } catch {
    return null;
  }
}

/** Every run of the project, newest first. */
export async function listOrchestratorRuns(
  base: string,
  token: string,
): Promise<OrchestratorRun[]> {
  const parsed = z
    .object({ runs: z.array(runSchema) })
    .safeParse(await call(base, token, 'GET', '/runs'));
  if (!parsed.success) throw new ApiError(0, 'bad_response', 'Unexpected orchestrator response.');
  return parsed.data.runs as unknown as OrchestratorRun[];
}

export async function getOrchestratorRun(
  base: string,
  token: string,
  id: string,
): Promise<OrchestratorRun> {
  return parseRun(await call(base, token, 'GET', `/runs/${encodeURIComponent(id)}`));
}

/** Starts a run (202). A 409 (`busy`, `no_agents`, `not_a_repository`) carries the reason. */
export async function startOrchestratorRun(
  base: string,
  token: string,
  input: StartRunInput,
): Promise<OrchestratorRun> {
  return parseRun(await call(base, token, 'POST', '/runs', input));
}

/**
 * Stops an active run (204 → true). A run that already ended (409 `not_active`) is not an
 * error for the user, who only wanted it stopped: resolves false.
 */
export async function cancelOrchestratorRun(
  base: string,
  token: string,
  id: string,
): Promise<boolean> {
  try {
    await call(base, token, 'POST', `/runs/${encodeURIComponent(id)}/cancel`);
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409 && e.code === 'not_active') return false;
    throw e;
  }
}

/** Merges the run's integration branch into its base branch. A 409 explains why it could not. */
export async function applyOrchestratorRun(
  base: string,
  token: string,
  id: string,
): Promise<OrchestratorRun> {
  return parseRun(await call(base, token, 'POST', `/runs/${encodeURIComponent(id)}/apply`));
}

// --- State ------------------------------------------------------------------------------------

export interface OutputLine {
  /** Stable within its stream, for React keys. */
  id: number;
  kind: AgentOutput['kind'];
  text: string;
}

export interface OutputStream {
  lines: OutputLine[];
  /** The last line is a `text` line still waiting for its newline. */
  open: boolean;
  next: number;
}

export interface OrchestratorState {
  runs: Record<string, OrchestratorRun>;
  /** Keyed by `outputKey(runId, taskId)`. */
  outputs: Record<string, OutputStream>;
}

export type OrchestratorEvent = Extract<
  DaveEvent,
  { type: 'orchestrator.run' | 'orchestrator.output' }
>;

export const EMPTY_ORCHESTRATOR_STATE: OrchestratorState = { runs: {}, outputs: {} };

export function outputKey(runId: string, taskId: string): string {
  return `${runId}\u0000${taskId}`;
}

export function isOrchestratorEvent(event: DaveEvent): event is OrchestratorEvent {
  return event.type === 'orchestrator.run' || event.type === 'orchestrator.output';
}

const EMPTY_STREAM: OutputStream = { lines: [], open: false, next: 0 };

/** Appends one chunk: consecutive `text` chunks join the last line until it gets a newline. */
export function appendOutput(stream: OutputStream, output: AgentOutput): OutputStream {
  const lines = stream.lines.slice();
  let { open, next } = stream;
  const text = output.text.replace(/\r\n?/g, '\n');

  if (output.kind === 'text') {
    if (text === '') return stream;
    const parts = text.split('\n');
    // A trailing newline closes the line; the empty remainder is not a line of its own.
    const closes = parts.at(-1) === '';
    if (closes) parts.pop();
    parts.forEach((part, i) => {
      const last = lines.at(-1);
      if (i === 0 && open && last) lines[lines.length - 1] = { ...last, text: last.text + part };
      else lines.push({ id: next++, kind: 'text', text: part });
    });
    open = !closes;
  } else {
    const trimmed = text.replace(/\n+$/, '');
    if (trimmed !== '') lines.push({ id: next++, kind: output.kind, text: trimmed });
    open = false;
  }

  return {
    lines: lines.length > MAX_OUTPUT_LINES ? lines.slice(-MAX_OUTPUT_LINES) : lines,
    open,
    next,
  };
}

/** Folds one event into the state. Unrelated or malformed events return the same object. */
export function applyOrchestratorEvent(
  state: OrchestratorState,
  event: DaveEvent,
): OrchestratorState {
  if (event.type === 'orchestrator.run') {
    const run = event.run;
    if (!run || typeof run.id !== 'string') return state;
    return { ...state, runs: { ...state.runs, [run.id]: run } };
  }
  if (event.type === 'orchestrator.output') {
    const { runId, taskId, output } = event;
    if (typeof runId !== 'string' || typeof taskId !== 'string') return state;
    if (!output || typeof output.text !== 'string') return state;
    const key = outputKey(runId, taskId);
    const stream = appendOutput(state.outputs[key] ?? EMPTY_STREAM, output);
    return { ...state, outputs: { ...state.outputs, [key]: stream } };
  }
  return state;
}

/**
 * Merges runs fetched over HTTP. A run already known from a newer event snapshot is kept, so a
 * slow `GET /runs` never rolls a run back.
 */
export function hydrateRuns(state: OrchestratorState, runs: OrchestratorRun[]): OrchestratorState {
  let next = state.runs;
  for (const run of runs) {
    const known = next[run.id];
    if (known && known.updatedAt > run.updatedAt) continue;
    if (next === state.runs) next = { ...state.runs };
    next[run.id] = run;
  }
  return next === state.runs ? state : { ...state, runs: next };
}

/** Runs newest first. */
export function sortedRuns(state: Pick<OrchestratorState, 'runs'>): OrchestratorRun[] {
  return Object.values(state.runs).sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
  );
}

/** A stream's lines; `empty` is returned as is, so callers can keep a stable reference. */
export function outputLines(
  state: OrchestratorState,
  runId: string,
  taskId: string,
  empty: OutputLine[] = [],
): OutputLine[] {
  return state.outputs[outputKey(runId, taskId)]?.lines ?? empty;
}

/**
 * Event-fed store with coalesced notifications, like `LiveStore`: a burst of output chunks
 * causes one render.
 */
export class OrchestratorStore {
  private state: OrchestratorState = EMPTY_ORCHESTRATOR_STATE;
  private pending: OrchestratorEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly flushMs = 100) {}

  getState = (): OrchestratorState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  ingest(event: OrchestratorEvent): void {
    this.pending.push(event);
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, this.flushMs);
    }
  }

  /** Puts a run returned by an HTTP call (start, apply) in place right away. */
  upsert(run: OrchestratorRun): void {
    this.flush();
    this.set(hydrateRuns(this.state, [run]));
  }

  hydrate(runs: OrchestratorRun[]): void {
    this.flush();
    this.set(hydrateRuns(this.state, runs));
  }

  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.set(batch.reduce(applyOrchestratorEvent, this.state));
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private set(next: OrchestratorState): void {
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

// --- View helpers -----------------------------------------------------------------------------

export function isActiveRun(run: Pick<OrchestratorRun, 'status'>): boolean {
  return run.status === 'planning' || run.status === 'running';
}

export function canApply(run: OrchestratorRun): boolean {
  return run.status === 'done' && !run.appliedAt && Boolean(run.integrationBranch);
}

/** The orchestrator is offered when the gateway has one and at least one agent is installed. */
export function orchestratorOffered(agents: AgentAvailability[] | null | undefined): boolean {
  return Boolean(agents?.some((a) => a.available));
}

export function availableAgents(agents: AgentAvailability[] | null | undefined) {
  return ORCHESTRATOR_AGENT_IDS.filter((id) => agents?.some((a) => a.agent === id && a.available));
}

/** Flips one agent in the selection, keeping the canonical order. */
export function toggleAgent(
  selection: readonly OrchestratorAgent[],
  agent: OrchestratorAgent,
): OrchestratorAgent[] {
  const has = selection.includes(agent);
  return ORCHESTRATOR_AGENT_IDS.filter((id) => (id === agent ? !has : selection.includes(id)));
}

/** The request for an objective, or null when there is nothing to send. */
export function startRequest(
  objective: string,
  selection: readonly OrchestratorAgent[],
  agents: AgentAvailability[] | null | undefined,
): StartRunInput | null {
  const text = objective.trim();
  const usable = availableAgents(agents).filter((id) => selection.includes(id));
  if (!text || usable.length === 0) return null;
  return { objective: text, agents: usable };
}

export type PlanStatus = 'running' | 'done' | 'failed' | 'cancelled';

/** Status of the planning step, shown as the first row of the task list. */
export function planStatus(run: OrchestratorRun): PlanStatus {
  if (run.status === 'planning') return 'running';
  if (run.tasks.length > 0) return 'done';
  return run.status === 'cancelled' ? 'cancelled' : run.status === 'failed' ? 'failed' : 'done';
}

/** What the panel shows first: the planner while planning, then the first busy task. */
export function defaultTaskId(run: OrchestratorRun): string {
  if (run.status === 'planning' || run.tasks.length === 0) return PLAN_TASK_ID;
  const busy =
    run.tasks.find((t) => t.status === 'running') ??
    run.tasks.find((t) => t.status === 'failed' || t.status === 'conflict');
  return (busy ?? run.tasks[0])?.id ?? PLAN_TASK_ID;
}

/** Milliseconds a task has run (still counting while it runs), or undefined before it starts. */
export function taskElapsedMs(
  task: Pick<OrchestratorTask, 'startedAt' | 'finishedAt'>,
  now: number,
): number | undefined {
  if (!task.startedAt) return undefined;
  const start = Date.parse(task.startedAt);
  if (Number.isNaN(start)) return undefined;
  const end = task.finishedAt ? Date.parse(task.finishedAt) : now;
  return Math.max(0, (Number.isNaN(end) ? now : end) - start);
}

/** Planning time: from the run's creation to its first task starting, or now while planning. */
export function planElapsedMs(run: OrchestratorRun, now: number): number | undefined {
  const start = Date.parse(run.createdAt);
  if (Number.isNaN(start)) return undefined;
  if (run.status === 'planning') return Math.max(0, now - start);
  const firstStart = run.tasks
    .map((t) => (t.startedAt ? Date.parse(t.startedAt) : Number.NaN))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b)[0];
  const end = firstStart ?? Date.parse(run.updatedAt);
  return Number.isNaN(end) ? undefined : Math.max(0, end - start);
}

/** Short status words for the panel. */
export const RUN_STATUS_LABEL: Record<OrchestratorRun['status'], string> = {
  planning: 'planning',
  running: 'running',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

export const TASK_STATUS_LABEL: Record<OrchestratorTask['status'] | PlanStatus, string> = {
  pending: 'waiting',
  running: 'running',
  done: 'done',
  failed: 'failed',
  conflict: 'conflict',
  cancelled: 'cancelled',
  skipped: 'skipped',
};
