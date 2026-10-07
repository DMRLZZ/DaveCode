import type { Usage } from '@davecode/core';
import { Box, Static, useApp, useInput, usePaste, useStdout, useWindowSize } from 'ink';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { Theme } from '../ui/theme';
import type { ChatBackend } from './backend';
import { chatReducer, initialChatState } from './chat-state';
import { InputBox, SlashHints } from './components/InputBox';
import { StatusLine } from './components/StatusLine';
import { EntryView, StreamingView } from './components/Transcript';
import * as ed from './editor';
import { completeSlash, parseSlash, slashSuggestions } from './slash';
import {
  accountsText,
  helpText,
  modelsText,
  routesText,
  statusText,
  tasksText,
} from './slash-actions';
import { ThemeProvider, useTheme } from './theme-context';

export interface ChatAppProps {
  backend: ChatBackend;
  theme: Theme;
  model: string;
  version: string;
  /** Health polling interval (tests use a short one). */
  pollMs?: number;
  /** Time source (tests). */
  now?: () => number;
}

const PLACEHOLDER = 'Ask anything · / for commands · Shift+Enter or Ctrl+J for a new line';
const EXIT_WINDOW_MS = 2000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function Chat({ backend, model, version, pollMs = 10_000, now = Date.now }: ChatAppProps) {
  const theme = useTheme();
  const { exit } = useApp();
  const { write } = useStdout();
  const { columns } = useWindowSize();
  const width = Math.max(20, columns);

  const [state, dispatch] = useReducer(chatReducer, model, initialChatState);
  const [editor, setEditor] = useState<ed.EditorState>(ed.emptyEditor);
  const [historyIndex, setHistoryIndex] = useState<number | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [clock, setClock] = useState(now());

  const abortRef = useRef<AbortController | undefined>(undefined);
  const exitArmedAt = useRef<number | undefined>(undefined);
  const labels = useRef(new Map<string, string>());
  const stateRef = useRef(state);
  stateRef.current = state;

  // --- lifecycle -----------------------------------------------------------

  useEffect(() => {
    const where = backend.inProcess ? `${backend.url} (in-process)` : backend.url;
    dispatch({
      type: 'banner',
      text: `${theme.bold(theme.accent('DaveCode'))} ${theme.dim(`v${version}`)}\n${theme.dim(
        `model ${model} · gateway ${where} · /help for commands`,
      )}`,
    });
    let alive = true;
    const check = async () => {
      const health = await backend.health();
      if (alive) dispatch({ type: 'connection', connection: health ? 'online' : 'offline' });
    };
    void check();
    backend
      .accounts()
      .then((accounts) => {
        for (const a of accounts) labels.current.set(a.id, a.label);
      })
      .catch(() => {});
    const timer = setInterval(() => void check(), pollMs);
    return () => {
      alive = false;
      clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [backend, model, pollMs, theme, version]);

  // Elapsed-time display while a reply is streaming.
  useEffect(() => {
    if (!state.streaming) return;
    const timer = setInterval(() => setClock(now()), 250);
    return () => clearInterval(timer);
  }, [state.streaming, now]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), EXIT_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // --- actions -------------------------------------------------------------

  const refreshQuota = useCallback(
    async (accountId: string) => {
      try {
        const usage = (await backend.usage()).find((u) => u.accountId === accountId);
        const window = usage?.windows['5h'];
        const limited =
          window && (window.tokenLimit !== undefined || window.requestLimit !== undefined);
        dispatch({
          type: 'quota',
          accountId,
          utilization: limited ? window.utilization : undefined,
        });
      } catch {
        // Quota is decoration; ignore failures.
      }
    },
    [backend],
  );

  const send = useCallback(
    async (text: string) => {
      dispatch({ type: 'user', text });
      const conversation = [
        ...stateRef.current.conversation,
        { role: 'user' as const, content: text },
      ];
      const controller = new AbortController();
      abortRef.current = controller;
      dispatch({ type: 'stream-start', now: now() });
      let usage: Usage | undefined;
      let accountId: string | undefined;
      try {
        const { meta, chunks } = await backend.stream(
          { model: stateRef.current.model, messages: conversation },
          controller.signal,
        );
        accountId = meta.accountId;
        dispatch({
          type: 'stream-meta',
          failovers: meta.failovers,
          ...(meta.accountId ? { accountId: meta.accountId } : {}),
          ...(meta.provider ? { provider: meta.provider } : {}),
          ...(meta.accountId && labels.current.has(meta.accountId)
            ? { accountLabel: labels.current.get(meta.accountId)! }
            : {}),
        });
        dispatch({ type: 'connection', connection: 'online' });
        for await (const chunk of chunks) {
          if (controller.signal.aborted) break;
          const delta = chunk.choices[0]?.delta?.content;
          if (typeof delta === 'string' && delta) dispatch({ type: 'stream-delta', text: delta });
          if (chunk.usage) usage = chunk.usage;
        }
        dispatch({
          type: 'stream-end',
          now: now(),
          ...(usage ? { usage } : {}),
          ...(controller.signal.aborted ? { cancelled: true } : {}),
        });
      } catch (err) {
        if (controller.signal.aborted) {
          dispatch({ type: 'stream-end', now: now(), cancelled: true });
        } else {
          const status = (err as { status?: number }).status;
          if (status === 0) dispatch({ type: 'connection', connection: 'offline' });
          dispatch({ type: 'stream-end', now: now(), error: errorText(err) });
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = undefined;
      }
      if (accountId) void refreshQuota(accountId);
    },
    [backend, now, refreshQuota],
  );

  const runSlash = useCallback(
    async (input: string) => {
      const parsed = parseSlash(input);
      if (parsed.kind === 'unknown') {
        dispatch({
          type: 'error',
          text: `Unknown command /${parsed.name}. Type /help for the list.`,
        });
        return;
      }
      if (parsed.kind !== 'command') return;
      const { command, args } = parsed;
      try {
        switch (command.name) {
          case 'help':
            dispatch({ type: 'info', text: helpText(theme) });
            break;
          case 'exit':
            abortRef.current?.abort();
            exit();
            break;
          case 'clear':
            abortRef.current?.abort();
            write('\u001b[2J\u001b[3J\u001b[H');
            dispatch({ type: 'clear' });
            break;
          case 'model':
            if (args) {
              dispatch({ type: 'set-model', model: args });
              dispatch({ type: 'info', text: `Model set to ${theme.accent(args)}` });
            } else {
              dispatch({
                type: 'info',
                text: await modelsText(theme, backend, stateRef.current.model),
              });
            }
            break;
          case 'route':
            dispatch({ type: 'info', text: await routesText(theme, backend) });
            break;
          case 'accounts': {
            const accounts = await backend.accounts();
            for (const a of accounts) labels.current.set(a.id, a.label);
            dispatch({ type: 'info', text: await accountsText(theme, backend, width - 4) });
            break;
          }
          case 'tasks':
            dispatch({ type: 'info', text: await tasksText(theme, backend, width - 4) });
            break;
          case 'status':
            dispatch({ type: 'info', text: await statusText(theme, backend) });
            break;
        }
      } catch (err) {
        dispatch({ type: 'error', text: `/${command.name} failed: ${errorText(err)}` });
      }
    },
    [backend, exit, theme, width, write],
  );

  const submit = useCallback(() => {
    const text = ed.textOf(editor).trim();
    if (!text) return;
    if (parseSlash(text).kind !== 'none') {
      setEditor(ed.emptyEditor);
      setHistoryIndex(undefined);
      void runSlash(text);
      return;
    }
    if (stateRef.current.streaming) {
      setNotice('Wait for the reply, or press Esc to cancel it');
      return;
    }
    setEditor(ed.emptyEditor);
    setHistoryIndex(undefined);
    void send(text);
  }, [editor, runSlash, send]);

  // --- keyboard --------------------------------------------------------------

  const recall = (direction: -1 | 1) => {
    const { history } = stateRef.current;
    if (history.length === 0) return;
    const current = historyIndex ?? history.length;
    const next = Math.min(history.length, Math.max(0, current + direction));
    setHistoryIndex(next === history.length ? undefined : next);
    setEditor(next === history.length ? ed.emptyEditor : ed.fromText(history[next]!));
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      const armed =
        exitArmedAt.current !== undefined && now() - exitArmedAt.current < EXIT_WINDOW_MS;
      if (armed) {
        abortRef.current?.abort();
        exit();
        return;
      }
      exitArmedAt.current = now();
      if (stateRef.current.streaming) abortRef.current?.abort();
      else if (editor.chars.length > 0) setEditor(ed.emptyEditor);
      setNotice('Press Ctrl+C again to exit');
      return;
    }
    exitArmedAt.current = undefined;

    if (key.escape) {
      if (stateRef.current.streaming) abortRef.current?.abort();
      return;
    }
    // New line: Ctrl+J (LF), Shift/Alt+Enter where the terminal reports it, or "\" + Enter.
    if ((input === '\n' && !key.return) || (key.ctrl && input === 'j')) {
      setEditor((e) => ed.insert(e, '\n'));
      return;
    }
    if (key.return) {
      if (key.shift || key.meta) setEditor((e) => ed.insert(e, '\n'));
      else if (ed.continuesLine(editor)) setEditor((e) => ed.newlineAfterBackslash(e));
      else submit();
      return;
    }
    if (key.tab) {
      const completed = completeSlash(ed.textOf(editor));
      if (completed) setEditor(ed.fromText(completed));
      return;
    }
    if (key.upArrow) {
      const moved = ed.up(editor);
      if (moved) setEditor(moved);
      else recall(-1);
      return;
    }
    if (key.downArrow) {
      const moved = ed.down(editor);
      if (moved) setEditor(moved);
      else if (historyIndex !== undefined) recall(1);
      return;
    }
    if (key.leftArrow) return setEditor(ed.left);
    if (key.rightArrow) return setEditor(ed.right);
    if (key.home || (key.ctrl && input === 'a')) return setEditor(ed.lineStart);
    if (key.end || (key.ctrl && input === 'e')) return setEditor(ed.lineEnd);
    if (key.backspace) return setEditor(ed.backspace);
    if (key.delete) return setEditor(ed.deleteForward);
    if (key.ctrl && input === 'u') return setEditor(ed.killToLineStart);
    if (key.ctrl && input === 'k') return setEditor(ed.killToLineEnd);
    if (key.ctrl && input === 'w') return setEditor(ed.deleteWordBack);
    if (key.ctrl && input === 'l') {
      write('\u001b[2J\u001b[H');
      return;
    }
    if (key.ctrl || key.meta || !input) return;
    setEditor((e) => ed.insert(e, input));
  });

  usePaste((text) => {
    setEditor((e) => ed.insert(e, text));
  });

  // --- render ----------------------------------------------------------------

  const suggestions = slashSuggestions(ed.textOf(editor));
  return (
    <Box flexDirection="column" width={width}>
      <Static key={state.epoch} items={state.entries}>
        {(entry) => <EntryView key={entry.id} entry={entry} />}
      </Static>
      {state.streaming ? <StreamingView streaming={state.streaming} now={clock} /> : null}
      <InputBox editor={editor} width={width} placeholder={PLACEHOLDER} />
      <SlashHints commands={suggestions} width={width} />
      <StatusLine
        state={state}
        width={width}
        info={{
          where: backend.inProcess ? `in-process ${new URL(backend.url).port}` : backend.url,
          inProcess: backend.inProcess,
          ...(notice ? { notice } : {}),
        }}
      />
    </Box>
  );
}

/** The chat TUI. Render with `render(<ChatApp …/>, { exitOnCtrlC: false })`. */
export function ChatApp(props: ChatAppProps) {
  return (
    <ThemeProvider theme={props.theme}>
      <Chat {...props} />
    </ThemeProvider>
  );
}
