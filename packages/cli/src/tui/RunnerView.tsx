import type { DaveEvent, RunnerState } from '@davecode/core';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { useEffect, useReducer, useRef, useState } from 'react';
import { bar, truncate } from '../ui/format';
import type { Theme } from '../ui/theme';
import { Spinner } from './components/Spinner';
import {
  isTerminal,
  type LogLine,
  PIPELINE,
  pipelineIndex,
  type RunnerViewState,
  runnerReducer,
} from './runner-state';
import { ThemeProvider, useTheme } from './theme-context';

const IDLE_STATES: readonly RunnerState[] = ['idle', 'paused', 'stopped', 'error'];

/** `selecting → preparing → implementing → …` with the current step highlighted. */
export function pipelineText(theme: Theme, state: RunnerState, repairCycle?: number): string {
  const current = pipelineIndex(state);
  const arrow = theme.dim(` ${theme.glyph.arrow} `);
  return PIPELINE.map((step, i) => {
    let label: string = step;
    if (step === 'validating' && state === 'repairing') {
      label = `repairing${repairCycle ? ` #${repairCycle}` : ''}`;
    }
    if (current === -1) return theme.dim(label);
    if (i < current) return theme.ok(label);
    if (i === current) return theme.bold(theme.accent(label));
    return theme.dim(label);
  }).join(arrow);
}

function logColor(theme: Theme, line: LogLine): (text: string) => string {
  if (line.level === 'error') return theme.error;
  if (line.level === 'warn') return theme.warn;
  if (line.level === 'debug') return theme.dim;
  return (t) => t;
}

export function logText(theme: Theme, line: LogLine, width: number): string {
  const time = new Date(line.ts).toTimeString().slice(0, 8);
  const prefix = `${time} `;
  return `${theme.dim(prefix)}${logColor(theme, line)(truncate(line.message.replace(/\s*\n\s*/g, ' '), Math.max(10, width - prefix.length)))}`;
}

export interface RunnerViewProps {
  state: RunnerViewState;
  maxRepairCycles: number;
  projectName: string;
  width: number;
  /** Number of log lines to show. */
  logLines: number;
  notice?: string;
}

/** Stateless runner dashboard: state machine position, current task, repair cycle, log tail. */
export function RunnerView({
  state,
  maxRepairCycles,
  projectName,
  width,
  logLines,
  notice,
}: RunnerViewProps) {
  const theme = useTheme();
  const { status } = state;
  const task = status.taskId ? state.tasks[status.taskId] : undefined;
  const busy = !IDLE_STATES.includes(status.state);
  const cycle = status.repairCycle ?? 0;
  const stateColor =
    status.state === 'error'
      ? theme.ink.error
      : status.state === 'paused' || status.state === 'stopped'
        ? theme.ink.warn
        : theme.ink.accent;
  const rule = theme.dim(theme.glyph.rule.repeat(Math.max(10, width)));
  const tail = state.logs.slice(-logLines);

  return (
    <Box flexDirection="column" width={width}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold color={theme.ink.accent}>
            DaveCode runner
          </Text>
          <Text dimColor={theme.ink.dim}> · {projectName}</Text>
        </Text>
        <Text dimColor={theme.ink.dim}>
          {state.done.success} done · {state.done.failed} failed
        </Text>
      </Box>
      <Box marginTop={1}>
        {busy ? <Spinner /> : <Text color={stateColor}>{theme.glyph.dot}</Text>}
        <Text bold color={stateColor}>
          {' '}
          {status.state}
        </Text>
        {status.startedAt ? (
          <Text dimColor={theme.ink.dim}> since {status.startedAt.slice(11, 19)}</Text>
        ) : null}
      </Box>
      <Text wrap="truncate-end">{pipelineText(theme, status.state, status.repairCycle)}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text wrap="truncate-end">
          <Text dimColor={theme.ink.dim}>{'task    '}</Text>
          {task ? (
            <Text>
              <Text bold>{task.id}</Text> {task.title}
              {task.attempts ? (
                <Text dimColor={theme.ink.dim}> · attempt {task.attempts}</Text>
              ) : null}
            </Text>
          ) : status.taskId ? (
            <Text bold>{status.taskId}</Text>
          ) : (
            <Text dimColor={theme.ink.dim}>none</Text>
          )}
        </Text>
        <Text>
          <Text dimColor={theme.ink.dim}>{'repair  '}</Text>
          {bar(
            theme,
            maxRepairCycles > 0 ? cycle / maxRepairCycles : 0,
            Math.max(1, maxRepairCycles * 2),
          )}{' '}
          {cycle}/{maxRepairCycles}
        </Text>
        {status.lastError ? (
          <Text color={theme.ink.error} wrap="truncate-end">
            {theme.glyph.fail} {status.lastError}
          </Text>
        ) : null}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text>{rule}</Text>
        {tail.length === 0 ? (
          <Text dimColor={theme.ink.dim}>waiting for runner output…</Text>
        ) : null}
        {tail.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: log lines are append-only
          <Text key={`${line.ts}-${i}`} wrap="truncate-end">
            {logText(theme, line, width)}
          </Text>
        ))}
        <Text>{rule}</Text>
      </Box>
      <Text dimColor={theme.ink.dim}>{notice ?? 'q or Ctrl+C stop safely · p pause/resume'}</Text>
    </Box>
  );
}

export interface RunnerAppProps {
  theme: Theme;
  initial: RunnerViewState;
  /** Subscribe to events (in-process bus or `/api/events`); returns an unsubscribe function. */
  subscribe: (onEvent: (event: DaveEvent) => void) => () => void;
  maxRepairCycles: number;
  projectName: string;
  stop: () => Promise<void>;
  pause?: () => void | Promise<void>;
  resume?: () => void | Promise<void>;
}

function RunnerScreen(props: RunnerAppProps) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [state, dispatch] = useReducer(runnerReducer, props.initial);
  const [notice, setNotice] = useState<string | undefined>();
  const stopping = useRef(false);
  const sawActive = useRef(!isTerminal(props.initial.status.state));

  useEffect(() => props.subscribe(dispatch), [props.subscribe]);

  // Leave once the runner comes to rest on its own (fatal error) or after our stop().
  useEffect(() => {
    if (!isTerminal(state.status.state)) {
      sawActive.current = true;
      return;
    }
    if (sawActive.current || stopping.current) {
      const timer = setTimeout(() => exit(), 50);
      return () => clearTimeout(timer);
    }
  }, [state.status.state, exit]);

  const requestStop = () => {
    if (stopping.current) {
      exit();
      return;
    }
    stopping.current = true;
    setNotice('Stopping safely (the task goes back to PENDING)… press again to quit now');
    props.stop().then(
      () => exit(),
      (err: unknown) => {
        setNotice(`stop failed: ${err instanceof Error ? err.message : String(err)}`);
        setTimeout(() => exit(), 500);
      },
    );
  };

  useInput((input, key) => {
    if ((key.ctrl && input === 'c') || input === 'q') return requestStop();
    if (input === 'p') {
      if (state.status.state === 'paused') void props.resume?.();
      else void props.pause?.();
    }
  });

  const width = Math.max(30, columns);
  const logLines = Math.max(3, Math.min(30, rows - 14));
  return (
    <RunnerView
      state={state}
      maxRepairCycles={props.maxRepairCycles}
      projectName={props.projectName}
      width={width}
      logLines={logLines}
      {...(notice ? { notice } : {})}
    />
  );
}

/** Live runner view. Render with `exitOnCtrlC: false` so Ctrl+C stops the runner safely. */
export function RunnerApp(props: RunnerAppProps) {
  return (
    <ThemeProvider theme={props.theme}>
      <RunnerScreen {...props} />
    </ThemeProvider>
  );
}
