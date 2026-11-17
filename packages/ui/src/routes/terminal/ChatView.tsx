import {
  ChevronDown,
  ChevronRight,
  FileDiff,
  SendHorizontal,
  Square,
  TerminalSquare,
  Trash2,
} from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { Markdown } from '../../components/Markdown';
import { errorMessage } from '../../lib/api';
import { isChatBusy } from '../../lib/chat';
import { cn } from '../../lib/cn';
import { useChatOutput } from '../../lib/data';
import { formatDuration } from '../../lib/format';
import type { OutputLine } from '../../lib/orchestrator';
import {
  useCancelChat,
  useChatPatch,
  useChatTranscript,
  useRemoveChat,
  useRenameChat,
  useSendChat,
} from '../../lib/queries';
import type { ChatSession, ChatTurn, OrchestratorAccess } from '../../lib/types';
import { DiffView } from './Changes';
import { kindMeta } from './kinds';
import { AccessToggle, AgentDot, useNow } from './Orchestrator';
import { EditableName } from './Pane';

/**
 * One agent chat: what the person asked, what the agent did step by step, its reply, and the
 * files it changed with their diff, then a box to write the next message.
 */
export function ChatView({
  session,
  defaultAccess,
  onOpenTerminals,
  onRemoved,
}: {
  session: ChatSession;
  defaultAccess: OrchestratorAccess;
  onOpenTerminals: () => void;
  onRemoved: () => void;
}) {
  useChatTranscript(session.id);
  const busy = isChatBusy(session);
  const send = useSendChat();
  const cancel = useCancelChat();
  const rename = useRenameChat();
  const remove = useRemoveChat();
  const [text, setText] = useState('');
  const [access, setAccess] = useState<OrchestratorAccess>(defaultAccess);
  const [error, setError] = useState<string>();
  const meta = kindMeta(session.agent);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: follow every new turn and reply
  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [session.turns]);

  const submit = () => {
    const message = text.trim();
    if (!message || busy || send.isPending) return;
    setError(undefined);
    stick.current = true;
    send.mutate(
      { id: session.id, text: message, access },
      {
        onSuccess: () => setText(''),
        onError: (e) => setError(errorMessage(e)),
      },
    );
  };

  return (
    <section
      aria-label={session.title}
      className="flex h-full min-h-0 flex-col font-mono text-[11px]"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-zinc-800 px-3 text-zinc-400">
        <AgentDot agent={session.agent} pulse={busy} />
        <span className="shrink-0 text-zinc-300">{meta.label}</span>
        <EditableName
          name={session.title}
          label="Chat title"
          onRename={(title) => rename.mutate({ id: session.id, title })}
          className="max-w-[40%] text-zinc-100"
        />
        <span
          className={cn('shrink-0', busy ? 'text-zinc-100' : 'text-zinc-600')}
          aria-live="polite"
        >
          {busy
            ? 'working…'
            : `${session.turns.length} ${session.turns.length === 1 ? 'message' : 'messages'}`}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {busy && (
            <button
              type="button"
              onClick={() => cancel.mutate(session.id)}
              className="flex h-6 items-center gap-1.5 rounded border border-zinc-700 px-2 text-zinc-200 hover:border-zinc-500"
            >
              <Square aria-hidden className="size-2.5" /> Stop
            </button>
          )}
          <button
            type="button"
            aria-label="Delete this chat"
            title="Delete this chat (the files the agent changed stay as they are)"
            disabled={busy || remove.isPending}
            onClick={() => remove.mutate(session.id, { onSuccess: onRemoved })}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-100 disabled:opacity-40"
          >
            <Trash2 aria-hidden className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onOpenTerminals}
            className="flex h-6 items-center gap-1.5 rounded px-2 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-100"
          >
            <TerminalSquare aria-hidden className="size-3" /> Terminals
          </button>
        </span>
      </header>

      <div
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-5">
          {session.turns.length === 0 && (
            <div className="mt-10 text-center text-zinc-500">
              <p className="text-sm text-zinc-200">Ask {meta.label} anything about this project.</p>
              <p className="mt-2 leading-relaxed">
                It works in the project folder with its own login. Each answer shows what it read,
                ran and edited, and the diff of every file it changed.
              </p>
            </div>
          )}
          {session.turns.map((turn) => (
            <Turn key={turn.id} session={session} turn={turn} />
          ))}
        </div>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="shrink-0 border-t border-zinc-800 p-2"
      >
        <div className="mx-auto max-w-3xl rounded-lg border border-zinc-800 bg-zinc-950 focus-within:border-zinc-600">
          <textarea
            aria-label={`Message to ${meta.label}`}
            rows={Math.min(8, Math.max(2, text.split('\n').length))}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              submit();
            }}
            placeholder={
              busy
                ? `${meta.label} is working…`
                : session.turns.length === 0
                  ? `Ask ${meta.label} to build, fix or explain something`
                  : 'Ask a follow-up'
            }
            className="block w-full resize-none bg-transparent px-3 pt-2 text-xs leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-600"
          />
          <div className="flex items-center gap-2 px-2 py-1.5">
            <AccessToggle access={access} onChange={setAccess} />
            {error && (
              <p role="alert" title={error} className="min-w-0 flex-1 truncate text-red-400">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={!text.trim() || busy || send.isPending}
              aria-label="Send"
              title="Enter to send, Shift+Enter for a new line"
              className="ml-auto flex h-6 items-center gap-1.5 rounded border border-zinc-500 bg-zinc-100 px-2 text-black hover:bg-white disabled:border-zinc-800 disabled:bg-transparent disabled:text-zinc-600"
            >
              <SendHorizontal aria-hidden className="size-3" /> Send
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}

function Turn({ session, turn }: { session: ChatSession; turn: ChatTurn }) {
  const lines = useChatOutput(session.id, turn.id);
  const running = turn.status === 'running';
  const now = useNow(running);
  const started = Date.parse(turn.startedAt);
  const ended = turn.finishedAt ? Date.parse(turn.finishedAt) : now;
  const seconds = Number.isNaN(started) ? undefined : Math.max(0, (ended - started) / 1000);
  // While the agent works its steps stay open; afterwards they fold behind the reply.
  const [stepsOpen, setStepsOpen] = useState<boolean>();
  const open = stepsOpen ?? running;
  const steps = lines.filter((line) => line.kind !== 'text' || running);
  const tools = steps.filter((l) => l.kind === 'tool');
  // The folded line shows the last real step, not a start-up notice.
  const last = tools.at(-1) ?? steps.filter((l) => l.kind !== 'status').at(-1);
  return (
    <article aria-label={`Message ${turn.id}`} className="flex flex-col gap-2">
      <div className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-zinc-800 px-3 py-2 text-xs leading-relaxed text-zinc-100">
        {turn.prompt}
      </div>
      <div className="flex flex-col gap-2">
        {steps.length > 0 && (
          <div className="rounded-md border border-zinc-800">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setStepsOpen(!open)}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-zinc-500 hover:text-zinc-200"
            >
              {open ? (
                <ChevronDown aria-hidden className="size-3" />
              ) : (
                <ChevronRight aria-hidden className="size-3" />
              )}
              <span>
                {running ? 'Working' : 'Worked'}
                {seconds !== undefined && ` for ${formatDuration(seconds)}`}
                {tools.length > 0 &&
                  ` · ${tools.length === 1 ? '1 step' : `${tools.length} steps`}`}
              </span>
              {!open && last && <span className="min-w-0 truncate text-zinc-600">{last.text}</span>}
            </button>
            {open && <Steps lines={steps} />}
          </div>
        )}
        {turn.reply && (
          <Markdown source={turn.reply} className="text-[13px] leading-relaxed text-zinc-200" />
        )}
        {turn.status === 'failed' && (
          <p className="whitespace-pre-wrap break-words text-red-400">
            {turn.error ?? 'The agent stopped.'}
          </p>
        )}
        {turn.status === 'cancelled' && <p className="text-zinc-600">Stopped.</p>}
        {turn.files && turn.files.length > 0 && <Files session={session} turn={turn} />}
      </div>
    </article>
  );
}

const STEP_CLASS: Record<OutputLine['kind'], string> = {
  text: 'text-zinc-300',
  tool: 'text-zinc-500',
  status: 'text-zinc-600',
  error: 'text-red-400',
};

function Steps({ lines }: { lines: OutputLine[] }) {
  return (
    <div
      role="log"
      className="max-h-64 overflow-y-auto border-t border-zinc-800 px-2 py-1.5 leading-relaxed"
    >
      {lines.map((line) => (
        <div key={line.id} className={cn('whitespace-pre-wrap break-words', STEP_CLASS[line.kind])}>
          {line.kind === 'tool' ? `› ${line.text}` : line.text}
        </div>
      ))}
    </div>
  );
}

function Files({ session, turn }: { session: ChatSession; turn: ChatTurn }) {
  const [open, setOpen] = useState(false);
  const patch = useChatPatch(session.id, turn.id, open);
  const files = turn.files ?? [];
  const added = files.reduce((n, f) => n + f.additions, 0);
  const removed = files.reduce((n, f) => n + f.deletions, 0);
  return (
    <div className="rounded-md border border-zinc-800">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-zinc-300 hover:bg-zinc-900"
      >
        <FileDiff aria-hidden className="size-3.5 shrink-0 text-zinc-500" />
        <span>
          {files.length === 1 ? `Edited ${files[0]?.path}` : `Edited ${files.length} files`}
        </span>
        <span className="ml-auto shrink-0 tabular-nums">
          <span className="text-emerald-400">+{added}</span>{' '}
          <span className="text-red-400">−{removed}</span>
        </span>
      </button>
      {open && (
        <div className="border-t border-zinc-800">
          {files.length > 1 && (
            <ul className="border-b border-zinc-900 px-2 py-1">
              {files.map((file) => (
                <li key={file.path} className="flex gap-2">
                  <span className="w-3 shrink-0 text-zinc-600">
                    {file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M'}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-zinc-300" title={file.path}>
                    {file.path}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    <span className="text-emerald-400">+{file.additions}</span>{' '}
                    <span className="text-red-400">−{file.deletions}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="max-h-[60vh] overflow-y-auto">
            {patch.isPending ? (
              <p className="p-2 text-zinc-600">Loading the diff…</p>
            ) : patch.isError ? (
              <p className="p-2 text-red-400">{errorMessage(patch.error)}</p>
            ) : (
              <DiffView patch={patch.data ?? ''} truncated={Boolean(turn.patchTruncated)} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
