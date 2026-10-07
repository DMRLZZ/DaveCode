import type { DaveEvent, DaveEventInput } from '@davecode/core';
import { render } from 'ink-testing-library';
import { createElement as h } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { plain } from '../test-utils';
import { pipelineText, RunnerApp, RunnerView } from './RunnerView';
import { initialRunnerState, LOG_LIMIT, pipelineIndex, runnerReducer } from './runner-state';
import { ThemeProvider } from './theme-context';

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const ev = (e: DaveEventInput): DaveEvent => ({ ts: 1_760_000_000_000, ...e }) as DaveEvent;

describe('runner state', () => {
  it('folds status, logs and task updates', () => {
    let s = initialRunnerState({ state: 'idle' }, [
      { id: 'api', title: 'Build the API', status: 'PENDING', dependsOn: [] },
    ]);
    s = runnerReducer(
      s,
      ev({ type: 'runner.status', status: { state: 'implementing', taskId: 'api' } }),
    );
    s = runnerReducer(
      s,
      ev({ type: 'runner.log', level: 'info', message: 'hello', taskId: 'api' }),
    );
    s = runnerReducer(
      s,
      ev({
        type: 'task.updated',
        task: { id: 'api', title: 'Build the API', status: 'SUCCESS', dependsOn: [] },
      }),
    );
    expect(s.status).toEqual({ state: 'implementing', taskId: 'api' });
    expect(s.logs).toHaveLength(1);
    expect(s.done).toEqual({ success: 1, failed: 0 });
    for (let i = 0; i < LOG_LIMIT + 10; i++) {
      s = runnerReducer(s, ev({ type: 'runner.log', level: 'debug', message: `${i}` }));
    }
    expect(s.logs).toHaveLength(LOG_LIMIT);
  });

  it('places repairing on the validating step', () => {
    expect(pipelineIndex('repairing')).toBe(pipelineIndex('validating'));
    expect(pipelineIndex('idle')).toBe(-1);
    expect(pipelineText(plain, 'repairing', 2)).toBe(
      'selecting → preparing → implementing → repairing #2 → merging',
    );
  });
});

describe('RunnerView', () => {
  it('shows the state, current task, repair cycle and log tail', () => {
    let state = initialRunnerState({ state: 'repairing', taskId: 'api', repairCycle: 2 }, [
      { id: 'api', title: 'Build the API', status: 'IN_PROGRESS', dependsOn: [], attempts: 1 },
    ]);
    state = runnerReducer(
      state,
      ev({ type: 'runner.log', level: 'warn', message: 'tests failed' }),
    );
    const ui = render(
      h(
        ThemeProvider,
        { theme: plain },
        h(RunnerView, { state, maxRepairCycles: 3, projectName: 'demo', width: 80, logLines: 5 }),
      ),
    );
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('DaveCode runner · demo');
    expect(frame).toContain('repairing');
    expect(frame).toContain('task    api Build the API · attempt 1');
    expect(frame).toContain('repair  ████░░ 2/3');
    expect(frame).toContain('tests failed');
    expect(frame).toContain('q or Ctrl+C stop safely');
    ui.unmount();
  });

  it('stops the runner on q and follows live events', async () => {
    const listeners = new Set<(e: DaveEvent) => void>();
    const stop = vi.fn(async () => {
      for (const l of listeners) l(ev({ type: 'runner.status', status: { state: 'stopped' } }));
    });
    const ui = render(
      h(RunnerApp, {
        theme: plain,
        initial: initialRunnerState({ state: 'selecting' }),
        subscribe: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        maxRepairCycles: 3,
        projectName: 'demo',
        stop,
      }),
    );
    await tick();
    for (const l of listeners) {
      l(ev({ type: 'runner.status', status: { state: 'implementing', taskId: 'x' } }));
      l(ev({ type: 'runner.log', level: 'info', message: 'editing src/app.ts' }));
    }
    await tick();
    expect(ui.lastFrame()).toContain('implementing');
    expect(ui.lastFrame()).toContain('editing src/app.ts');
    ui.stdin.write('q');
    await tick(100);
    expect(stop).toHaveBeenCalledTimes(1);
    ui.unmount();
  });
});
