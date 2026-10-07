import type { DaveEvent, LogLevel, RunnerState, RunnerStatus, TaskNode } from '@davecode/core';

/** Pure state behind the runner view, folded from `runner.*` and `task.updated` events. */

export interface LogLine {
  ts: number;
  level: LogLevel;
  message: string;
  taskId?: string;
}

export interface RunnerViewState {
  status: RunnerStatus;
  /** Latest known version of each task (from `task.updated` or the initial graph). */
  tasks: Record<string, Pick<TaskNode, 'id' | 'title' | 'status' | 'attempts'>>;
  logs: LogLine[];
  /** Tasks finished in this session. */
  done: { success: number; failed: number };
}

export const LOG_LIMIT = 200;

export function initialRunnerState(
  status: RunnerStatus = { state: 'idle' },
  tasks: TaskNode[] = [],
): RunnerViewState {
  return {
    status,
    tasks: Object.fromEntries(
      tasks.map((t) => [
        t.id,
        {
          id: t.id,
          title: t.title,
          status: t.status,
          ...(t.attempts ? { attempts: t.attempts } : {}),
        },
      ]),
    ),
    logs: [],
    done: { success: 0, failed: 0 },
  };
}

export function runnerReducer(state: RunnerViewState, event: DaveEvent): RunnerViewState {
  switch (event.type) {
    case 'runner.status':
      return { ...state, status: event.status };
    case 'runner.log': {
      const line: LogLine = { ts: event.ts, level: event.level, message: event.message };
      if (event.taskId) line.taskId = event.taskId;
      return { ...state, logs: [...state.logs, line].slice(-LOG_LIMIT) };
    }
    case 'task.updated': {
      const { task } = event;
      const previous = state.tasks[task.id];
      const done = { ...state.done };
      if (previous?.status !== task.status) {
        if (task.status === 'SUCCESS') done.success++;
        if (task.status === 'FAILED') done.failed++;
      }
      return {
        ...state,
        done,
        tasks: {
          ...state.tasks,
          [task.id]: {
            id: task.id,
            title: task.title,
            status: task.status,
            ...(task.attempts ? { attempts: task.attempts } : {}),
          },
        },
      };
    }
    default:
      return state;
  }
}

/** The happy path of the state machine, as drawn in the view. */
export const PIPELINE: readonly RunnerState[] = [
  'selecting',
  'preparing',
  'implementing',
  'validating',
  'merging',
];

/** Index of `state` on the pipeline (`repairing` sits on `validating`), or -1 off-pipeline. */
export function pipelineIndex(state: RunnerState): number {
  if (state === 'repairing') return PIPELINE.indexOf('validating');
  return PIPELINE.indexOf(state);
}

/** True once the runner has come to rest after a stop or a fatal error. */
export function isTerminal(state: RunnerState): boolean {
  return state === 'stopped' || state === 'error';
}
