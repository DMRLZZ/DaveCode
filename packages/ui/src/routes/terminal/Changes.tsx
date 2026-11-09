import {
  Check,
  ChevronDown,
  ExternalLink,
  GitBranch,
  GitCompareArrows,
  GitMerge,
  Maximize2,
  Minimize2,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { errorMessage } from '../../lib/api';
import {
  canShip,
  type DiffFile,
  defaultShipAction,
  FILE_STATUS_LETTER,
  parsePatch,
  SHIP_ACTION_LABEL,
  type ShipAction,
  shipActions,
  shipRequest,
  shortBranch,
} from '../../lib/changes';
import { cn } from '../../lib/cn';
import {
  useChangesDiff,
  useMergeWorkspace,
  useRemoveWorkspace,
  useShipWorkspace,
  useSuggestText,
} from '../../lib/queries';
import type {
  ChangedFile,
  ChangesSuggestion,
  ChangesWorkspace,
  OrchestratorAgent,
  ShipResult,
} from '../../lib/types';
import { KINDS } from './kinds';

/** Most diff lines rendered at once; the rest wait behind "Show more". */
const LINE_BUDGET = 3000;

const STATUS_COLOR: Record<ChangedFile['status'], string> = {
  added: 'text-emerald-400',
  untracked: 'text-emerald-400',
  modified: 'text-amber-300',
  deleted: 'text-red-400',
  renamed: 'text-sky-300',
};

/** An isolated workspace takes its pane's accent (it is labelled with the agent's name). */
export function workspaceAccent(workspace: Pick<ChangesWorkspace, 'label' | 'isolated'>): string {
  if (!workspace.isolated) return '#ffffff';
  return KINDS.find((k) => k.label === workspace.label)?.accent ?? '#a1a1aa';
}

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 tabular-nums">
      <span className="text-emerald-400">+{additions}</span>{' '}
      <span className="text-red-400">−{deletions}</span>
    </span>
  );
}

// --- Bottom bar -------------------------------------------------------------------------------

export function ChangesToggle({
  open,
  count,
  onToggle,
}: {
  open: boolean;
  count: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={open ? 'Hide changes' : 'Review changes'}
      aria-expanded={open}
      aria-controls="changes-panel"
      title="Review changes, commit, push and open a pull request"
      onClick={onToggle}
      className={cn(
        'ml-2 flex h-6 shrink-0 items-center gap-1 rounded px-1.5 font-mono text-[11px] hover:bg-zinc-900 hover:text-zinc-100',
        open ? 'text-zinc-200' : 'text-zinc-500',
      )}
    >
      <GitCompareArrows aria-hidden className="size-3.5" />
      {count > 0 && <span className="tabular-nums">{count}</span>}
    </button>
  );
}

// --- Panel ------------------------------------------------------------------------------------

export function ChangesPanel({
  workspaces,
  error,
  selectedId,
  onSelect,
  onClose,
  agents,
}: {
  workspaces: ChangesWorkspace[] | undefined;
  error: string | undefined;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onClose: () => void;
  /** Installed agents that can write the commit message. */
  agents: readonly OrchestratorAgent[];
}) {
  const [wide, setWide] = useState(false);
  const selected = workspaces?.find((w) => w.id === selectedId) ?? workspaces?.[0];
  const checkout = workspaces?.find((w) => !w.isolated);
  return (
    <aside
      id="changes-panel"
      aria-label="Changes"
      className={cn(
        'my-1 mr-1 flex shrink-0 flex-col border border-zinc-800 bg-black font-mono text-[11px] text-zinc-400',
        wide ? 'w-[min(960px,62vw)]' : 'w-[440px]',
      )}
    >
      <header className="flex h-7 shrink-0 items-center gap-2 border-b border-zinc-800 px-2">
        <GitCompareArrows aria-hidden className="size-3 text-zinc-300" />
        <span className="text-zinc-300">Changes</span>
        <span className="ml-auto" />
        <button
          type="button"
          aria-label={wide ? 'Narrow the changes panel' : 'Widen the changes panel'}
          aria-pressed={wide}
          onClick={() => setWide((w) => !w)}
          className="rounded p-0.5 hover:bg-zinc-800 hover:text-zinc-100"
        >
          {wide ? (
            <Minimize2 aria-hidden className="size-3" />
          ) : (
            <Maximize2 aria-hidden className="size-3" />
          )}
        </button>
        <button
          type="button"
          aria-label="Close the changes panel"
          onClick={onClose}
          className="rounded p-0.5 hover:bg-zinc-800 hover:text-zinc-100"
        >
          <X aria-hidden className="size-3" />
        </button>
      </header>
      {error ? (
        <p role="alert" className="p-3 leading-relaxed text-zinc-400">
          {error}
        </p>
      ) : !workspaces ? (
        <p className="p-3 text-zinc-600">Reading the repository…</p>
      ) : (
        <>
          <WorkspaceList workspaces={workspaces} selectedId={selected?.id} onSelect={onSelect} />
          {selected && (
            <WorkspaceView
              key={selected.id}
              workspace={selected}
              checkoutBranch={checkout?.branch}
              agents={agents}
              onRemoved={() => onSelect('main')}
            />
          )}
        </>
      )}
    </aside>
  );
}

function WorkspaceList({
  workspaces,
  selectedId,
  onSelect,
}: {
  workspaces: ChangesWorkspace[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <nav
      aria-label="Workspaces"
      className="max-h-36 shrink-0 overflow-y-auto border-b border-zinc-800 py-1"
    >
      {workspaces.map((w) => (
        <button
          key={w.id}
          type="button"
          aria-current={w.id === selectedId ? 'true' : undefined}
          onClick={() => onSelect(w.id)}
          className={cn(
            'flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-zinc-900',
            w.id === selectedId && 'bg-zinc-900 text-zinc-100',
          )}
        >
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full"
            style={{ background: workspaceAccent(w) }}
          />
          <span className="truncate text-zinc-200">{w.isolated ? w.label : 'Project'}</span>
          <span className="flex min-w-0 items-center gap-1 truncate text-zinc-600">
            <GitBranch aria-hidden className="size-3 shrink-0" />
            {shortBranch(w.branch)}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {w.files.length > 0 ? (
              <Counts additions={w.additions} deletions={w.deletions} />
            ) : (
              <span className="text-zinc-700">clean</span>
            )}
            {w.unpushed > 0 && <span title="Commits not pushed yet">↑{w.unpushed}</span>}
          </span>
        </button>
      ))}
    </nav>
  );
}

function WorkspaceView({
  workspace,
  checkoutBranch,
  agents,
  onRemoved,
}: {
  workspace: ChangesWorkspace;
  checkoutBranch: string | undefined;
  agents: readonly OrchestratorAgent[];
  onRemoved: () => void;
}) {
  const [file, setFile] = useState<string>();
  const exists = file === undefined || workspace.files.some((f) => f.path === file);
  const shownFile = exists ? file : undefined;
  // The patch is refetched whenever the file list or its counts change.
  const version = workspace.files.map((f) => `${f.path}:${f.additions}:${f.deletions}`).join('|');
  const diff = useChangesDiff(workspace.id, shownFile, `${version}#${workspace.ahead}`);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-zinc-800 px-2 py-1.5 text-zinc-500">
        <span className="flex items-center gap-1 text-zinc-300">
          <GitBranch aria-hidden className="size-3" />
          {workspace.branch ?? 'detached HEAD'}
        </span>
        {workspace.baseBranch && <span>from {workspace.baseBranch}</span>}
        {workspace.ahead > 0 && workspace.isolated && (
          <span>
            {workspace.ahead} commit{workspace.ahead === 1 ? '' : 's'} ahead
          </span>
        )}
        {workspace.upstream ? (
          workspace.unpushed > 0 ? (
            <span>{workspace.unpushed} to push</span>
          ) : (
            <span>pushed</span>
          )
        ) : workspace.hasRemote ? (
          <span>not pushed</span>
        ) : (
          <span>no remote</span>
        )}
      </p>
      {workspace.files.length === 0 ? (
        <p className="p-3 text-zinc-600">
          {workspace.isolated
            ? 'No changes in this workspace yet. Agents opened in it work on its branch.'
            : 'No uncommitted changes.'}
        </p>
      ) : (
        <>
          <FileList files={workspace.files} selected={shownFile} onSelect={setFile} />
          <div className="min-h-0 flex-1 overflow-auto">
            {diff.isError ? (
              <p role="alert" className="p-3 text-red-400">
                {errorMessage(diff.error)}
              </p>
            ) : diff.data ? (
              <DiffView
                key={shownFile ?? '*'}
                patch={diff.data.patch}
                truncated={diff.data.truncated}
              />
            ) : (
              <p className="p-3 text-zinc-600">Loading the diff…</p>
            )}
          </div>
        </>
      )}
      <ShipBox
        workspace={workspace}
        checkoutBranch={checkoutBranch}
        agents={agents}
        onRemoved={onRemoved}
      />
    </div>
  );
}

function FileList({
  files,
  selected,
  onSelect,
}: {
  files: ChangedFile[];
  selected: string | undefined;
  onSelect: (path: string | undefined) => void;
}) {
  return (
    <ul
      aria-label="Changed files"
      className="max-h-40 shrink-0 overflow-y-auto border-b border-zinc-800 py-1"
    >
      <li>
        <button
          type="button"
          aria-current={selected === undefined ? 'true' : undefined}
          onClick={() => onSelect(undefined)}
          className={cn(
            'flex w-full items-center gap-2 px-2 py-0.5 text-left hover:bg-zinc-900',
            selected === undefined && 'bg-zinc-900 text-zinc-100',
          )}
        >
          <span className="w-3" />
          All files ({files.length})
        </button>
      </li>
      {files.map((f) => {
        const slash = f.path.lastIndexOf('/');
        return (
          <li key={f.path}>
            <button
              type="button"
              title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
              aria-current={selected === f.path ? 'true' : undefined}
              onClick={() => onSelect(f.path)}
              className={cn(
                'flex w-full items-center gap-2 px-2 py-0.5 text-left hover:bg-zinc-900',
                selected === f.path && 'bg-zinc-900 text-zinc-100',
              )}
            >
              <span className={cn('w-3 shrink-0 text-center', STATUS_COLOR[f.status])}>
                {FILE_STATUS_LETTER[f.status]}
              </span>
              <span className="min-w-0 truncate">
                <span className="text-zinc-200">{f.path.slice(slash + 1)}</span>
                {slash > 0 && (
                  <span className="ml-1.5 text-zinc-600">{f.path.slice(0, slash)}</span>
                )}
              </span>
              <span className="ml-auto pl-2">
                {f.binary ? (
                  <span className="text-zinc-600">binary</span>
                ) : (
                  <Counts additions={f.additions} deletions={f.deletions} />
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// --- Diff -------------------------------------------------------------------------------------

function DiffView({ patch, truncated }: { patch: string; truncated: boolean }) {
  const files = useMemo(() => parsePatch(patch), [patch]);
  const [budget, setBudget] = useState(LINE_BUDGET);
  if (files.length === 0) return <p className="p-3 text-zinc-600">No textual changes.</p>;
  let left = budget;
  const shown: DiffFile[] = [];
  for (const file of files) {
    if (left <= 0) break;
    const hunks = [];
    for (const hunk of file.hunks) {
      if (left <= 0) break;
      const lines = hunk.lines.slice(0, left);
      left -= lines.length;
      hunks.push({ ...hunk, lines });
    }
    shown.push({ ...file, hunks });
  }
  const total = files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length, 0), 0);
  return (
    <div className="pb-2">
      {shown.map((file) => (
        <section key={`${file.oldPath ?? ''}>${file.path}`} aria-label={`Diff of ${file.path}`}>
          <h3 className="sticky top-0 z-10 truncate border-y border-zinc-800 bg-zinc-950 px-2 py-1 text-zinc-300">
            {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
          </h3>
          {file.binary && <p className="px-2 py-1 text-zinc-600">Binary file</p>}
          {file.hunks.length === 0 && !file.binary && (
            <p className="px-2 py-1 text-zinc-600">No content changes (mode or rename only)</p>
          )}
          {file.hunks.map((hunk, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: hunks have no identity beyond their order
            <table key={i} className="w-full border-collapse leading-[1.45]">
              <tbody>
                <tr>
                  <td colSpan={3} className="bg-zinc-950 px-2 text-zinc-600">
                    {hunk.header}
                  </td>
                </tr>
                {hunk.lines.map((line, j) => (
                  <tr
                    // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
                    key={j}
                    className={cn(
                      line.kind === 'add' && 'bg-emerald-500/10 text-emerald-100',
                      line.kind === 'del' && 'bg-red-500/10 text-red-100',
                      line.kind === 'ctx' && 'text-zinc-400',
                      line.kind === 'note' && 'text-zinc-600 italic',
                    )}
                  >
                    <td className="w-9 select-none pr-1 text-right align-top text-zinc-700">
                      {line.oldNo ?? ''}
                    </td>
                    <td className="w-9 select-none pr-1 text-right align-top text-zinc-700">
                      {line.newNo ?? ''}
                    </td>
                    <td className="whitespace-pre-wrap break-all pr-2 pl-1">
                      <span aria-hidden className="mr-1 select-none text-zinc-600">
                        {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
                      </span>
                      {line.text}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </section>
      ))}
      {total > budget && (
        <button
          type="button"
          onClick={() => setBudget((b) => b + LINE_BUDGET)}
          className="m-2 rounded border border-zinc-800 px-2 py-1 text-zinc-300 hover:bg-zinc-900"
        >
          Show more ({total - budget} lines left)
        </button>
      )}
      {truncated && (
        <p className="px-2 pt-2 text-zinc-600">The patch is too large to show in full.</p>
      )}
    </div>
  );
}

// --- Commit, push, PR, merge ------------------------------------------------------------------

const WRITER_LABEL: Record<ChangesSuggestion['by'], string> = {
  davecode: 'File list',
  claude: 'Claude Code',
  codex: 'Codex',
  agy: 'Antigravity',
};

function ShipBox({
  workspace,
  checkoutBranch,
  agents,
  onRemoved,
}: {
  workspace: ChangesWorkspace;
  checkoutBranch: string | undefined;
  agents: readonly OrchestratorAgent[];
  onRemoved: () => void;
}) {
  const actions = shipActions(workspace);
  const [action, setAction] = useState<ShipAction>(() => defaultShipAction(workspace));
  const [message, setMessage] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState(false);
  const [writer, setWriter] = useState<ChangesSuggestion['by']>('davecode');
  const [result, setResult] = useState<ShipResult>();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const ship = useShipWorkspace();
  const merge = useMergeWorkspace();
  const remove = useRemoveWorkspace();
  const suggest = useSuggestText();
  const hasFiles = workspace.files.length > 0;
  const chosen = actions.includes(action) ? action : 'commit';

  const fill = (suggestion: ChangesSuggestion) => {
    setMessage(suggestion.message);
    setTitle(suggestion.title);
    setBody(suggestion.body);
  };

  // Start from the free, instant suggestion; an agent can rewrite it on request.
  const { mutate: suggestMutate } = suggest;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per workspace with changes
  useEffect(() => {
    if (hasFiles && !message) suggestMutate({ id: workspace.id }, { onSuccess: fill });
  }, [hasFiles, workspace.id]);

  const write = () => suggest.mutate({ id: workspace.id, agent: writer }, { onSuccess: fill });

  const submit = () => {
    setResult(undefined);
    ship.mutate(
      {
        id: workspace.id,
        ship: shipRequest(chosen, { message, title, body, draft }, workspace.dirty),
      },
      {
        onSuccess: (r) => {
          setResult(r);
          if (r.ok) {
            setMessage('');
            setTitle('');
            setBody('');
          }
        },
      },
    );
  };

  const busy = ship.isPending || merge.isPending || remove.isPending;
  const ready = canShip(workspace, chosen, message, title) && !busy;
  const mergeable =
    workspace.isolated && (workspace.ahead > 0 || workspace.dirty) && checkoutBranch;
  const error = ship.error ?? merge.error ?? remove.error;

  return (
    <form
      aria-label="Commit and ship"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) submit();
      }}
      className="shrink-0 space-y-1.5 border-t border-zinc-800 p-2"
    >
      {(hasFiles || workspace.unpushed > 0) && (
        <>
          {workspace.dirty && (
            <div className="flex items-center gap-1">
              <input
                aria-label="Commit message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Commit message"
                className="h-7 min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-600"
              />
              <label className="sr-only" htmlFor={`writer-${workspace.id}`}>
                Who writes the message
              </label>
              <select
                id={`writer-${workspace.id}`}
                value={writer}
                onChange={(e) => setWriter(e.target.value as ChangesSuggestion['by'])}
                className="h-7 rounded border border-zinc-800 bg-black px-1 text-zinc-400"
              >
                <option value="davecode">{WRITER_LABEL.davecode}</option>
                {agents.map((a) => (
                  <option key={a} value={a}>
                    {WRITER_LABEL[a]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={write}
                disabled={suggest.isPending}
                title="Write the commit message and pull request text"
                className="flex h-7 items-center gap-1 rounded border border-zinc-800 px-2 text-zinc-300 hover:bg-zinc-900 disabled:opacity-50"
              >
                <Sparkles
                  aria-hidden
                  className={cn('size-3', suggest.isPending && 'animate-pulse')}
                />
                {suggest.isPending
                  ? writer === 'davecode'
                    ? 'Writing…'
                    : `${WRITER_LABEL[writer]} is writing…`
                  : 'Write'}
              </button>
            </div>
          )}
          {suggest.isError && (
            <p role="alert" className="text-red-400">
              {errorMessage(suggest.error)}
            </p>
          )}
          {chosen === 'commit_push_pr' && (
            <>
              <input
                aria-label="Pull request title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Pull request title"
                className="h-7 w-full rounded border border-zinc-800 bg-zinc-950 px-2 text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-600"
              />
              <textarea
                aria-label="Pull request description"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Pull request description (Markdown)"
                rows={3}
                className="w-full resize-y rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-600"
              />
              <label className="flex items-center gap-1.5 text-zinc-500">
                <input
                  type="checkbox"
                  checked={draft}
                  onChange={(e) => setDraft(e.target.checked)}
                />
                Open as draft
              </label>
            </>
          )}
          <div className="flex items-center gap-1">
            <button
              type="submit"
              disabled={!ready}
              className="flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded bg-zinc-100 px-2 font-medium text-black hover:bg-white disabled:bg-zinc-800 disabled:text-zinc-500"
            >
              {ship.isPending ? 'Working…' : shipButtonLabel(chosen, workspace.dirty)}
            </button>
            {actions.length > 1 && (
              <div className="relative">
                <label className="sr-only" htmlFor={`action-${workspace.id}`}>
                  What the button does
                </label>
                <select
                  id={`action-${workspace.id}`}
                  value={chosen}
                  onChange={(e) => setAction(e.target.value as ShipAction)}
                  className="h-7 appearance-none rounded border border-zinc-800 bg-black pr-6 pl-2 text-zinc-300"
                >
                  {actions.map((a) => (
                    <option key={a} value={a}>
                      {SHIP_ACTION_LABEL[a]}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  aria-hidden
                  className="pointer-events-none absolute top-2 right-1.5 size-3 text-zinc-500"
                />
              </div>
            )}
          </div>
        </>
      )}

      {workspace.isolated && (
        <div className="flex items-center gap-1">
          {mergeable && (
            <button
              type="button"
              disabled={busy || (workspace.dirty && !message.trim())}
              title={
                workspace.dirty
                  ? 'Commits the changes with the message above, then merges the branch'
                  : `Merge ${workspace.branch ?? 'this branch'} into ${checkoutBranch}`
              }
              onClick={() => {
                setResult(undefined);
                merge.mutate({ id: workspace.id, ...(workspace.dirty ? { message } : {}) });
              }}
              className="flex h-7 items-center gap-1 rounded border border-zinc-800 px-2 text-zinc-300 hover:bg-zinc-900 disabled:opacity-50"
            >
              <GitMerge aria-hidden className="size-3" />
              {merge.isPending ? 'Merging…' : `Merge into ${checkoutBranch}`}
            </button>
          )}
          <span className="ml-auto" />
          {confirmRemove ? (
            <>
              <span className="text-zinc-500">Remove the worktree? The branch stays.</span>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  remove.mutate(
                    { id: workspace.id, deleteBranch: false },
                    { onSuccess: onRemoved, onSettled: () => setConfirmRemove(false) },
                  )
                }
                className="h-7 rounded border border-red-900 px-2 text-red-300 hover:bg-red-950"
              >
                Remove
              </button>
              <button
                type="button"
                onClick={() => setConfirmRemove(false)}
                className="h-7 rounded px-2 text-zinc-500 hover:text-zinc-200"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              aria-label="Remove this isolated workspace"
              title="Remove this isolated workspace (its branch stays)"
              onClick={() => setConfirmRemove(true)}
              className="rounded p-1.5 text-zinc-600 hover:bg-zinc-900 hover:text-zinc-200"
            >
              <Trash2 aria-hidden className="size-3" />
            </button>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-red-400">
          {errorMessage(error)}
        </p>
      )}
      {merge.isSuccess && !merge.isPending && (
        <p className="text-zinc-400">
          Merged into {checkoutBranch}. Review it under Project before you push.
        </p>
      )}
      {result && <ShipSteps result={result} />}
    </form>
  );
}

function shipButtonLabel(action: ShipAction, dirty: boolean): string {
  if (dirty) return SHIP_ACTION_LABEL[action];
  if (action === 'commit_push') return 'Push';
  if (action === 'commit_push_pr') return 'Push & open PR';
  return 'Commit';
}

const PHASE_LABEL = {
  branch: 'Branch',
  commit: 'Commit',
  push: 'Push',
  pr: 'Pull request',
} as const;

function ShipSteps({ result }: { result: ShipResult }) {
  return (
    <ol aria-label="What happened" className="space-y-0.5">
      {result.steps.map((step) => (
        <li key={step.phase} className="flex items-start gap-1.5">
          {step.ok ? (
            <Check aria-label="done" className="mt-0.5 size-3 shrink-0 text-emerald-400" />
          ) : (
            <X aria-label="failed" className="mt-0.5 size-3 shrink-0 text-red-400" />
          )}
          <span className="text-zinc-500">{PHASE_LABEL[step.phase]}</span>
          {step.phase === 'pr' && step.ok && result.prUrl ? (
            <a
              href={result.prUrl}
              target="_blank"
              rel="noreferrer"
              className="flex min-w-0 items-center gap-1 truncate text-zinc-100 underline underline-offset-2"
            >
              {result.prUrl.replace(/^https:\/\/github\.com\//, '')}
              <ExternalLink aria-hidden className="size-3 shrink-0" />
            </a>
          ) : (
            <span className={cn('min-w-0 break-words', step.ok ? 'text-zinc-300' : 'text-red-300')}>
              {step.detail}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
