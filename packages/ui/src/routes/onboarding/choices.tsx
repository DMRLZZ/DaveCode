import {
  Bell,
  Check,
  MessageSquare,
  Monitor,
  Moon,
  Sun,
  Terminal,
  TriangleAlert,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { AGENT_LIST, type AgentId } from '../../lib/agents';
import { cn } from '../../lib/cn';
import { testNotification } from '../../lib/notify';
import {
  type ColorMode,
  type Preferences,
  resolvedColorMode,
  type ShellId,
  setColorMode,
  updatePreferences,
} from '../../lib/preferences';
import { playSound, SOUND_IDS, SOUND_LABEL, type SoundId } from '../../lib/sounds';
import { TERMINAL_THEMES, type TerminalTheme, terminalTheme } from '../../lib/terminal-themes';

/**
 * The choices of the first-run setup, each one a small control that changes a preference at
 * once. Settings uses the same controls, so a choice looks the same in both places.
 */

export { useInstalled } from '../../lib/installed';

function Card({
  selected,
  disabled = false,
  onSelect,
  children,
  className,
  label,
}: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  children: ReactNode;
  className?: string;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      aria-disabled={disabled}
      onClick={() => !disabled && onSelect()}
      className={cn(
        'relative flex flex-col rounded-lg border text-left transition-colors',
        selected ? 'border-zinc-300 bg-zinc-950' : 'border-zinc-800 hover:border-zinc-600',
        disabled && 'cursor-not-allowed opacity-40 hover:border-zinc-800',
        className,
      )}
    >
      {children}
      {selected && (
        <span className="absolute top-2.5 right-2.5 flex size-4 items-center justify-center rounded-full bg-zinc-100 text-black">
          <Check aria-hidden className="size-3" strokeWidth={3} />
        </span>
      )}
    </button>
  );
}

function Segment<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { id: T; label: string; icon?: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <fieldset className="min-w-0 inline-flex rounded-md border border-zinc-800 p-0.5">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            'flex h-7 items-center gap-1.5 rounded px-3 text-xs',
            value === option.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200',
          )}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-2">
      <h3 className="text-sm text-zinc-100">{children}</h3>
      {hint && <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{hint}</p>}
    </div>
  );
}

// --- Work mode --------------------------------------------------------------------------------

export function WorkModeChoice({ preferences }: { preferences: Preferences }) {
  const mode = preferences.workMode;
  return (
    <fieldset className="min-w-0 grid gap-3 md:grid-cols-2">
      <legend className="sr-only">Where new agents open</legend>
      <Card
        label="Terminal"
        selected={mode === 'terminal'}
        onSelect={() => updatePreferences({ workMode: 'terminal' })}
      >
        <div className="m-3 rounded-md border border-zinc-800 bg-black p-3 font-mono text-[11px] leading-relaxed">
          <p className="text-zinc-500">~/project</p>
          <p className="text-zinc-100">› claude</p>
          <p className="text-zinc-300">› add retry to fetchUser</p>
          <p className="text-zinc-500">● Update(src/api.ts)</p>
          <p className="text-red-400"> 12 − return fetch(url)</p>
          <p className="text-emerald-400"> 12 + return withRetry(fetch, url)</p>
          <p className="text-zinc-300">● Done.</p>
        </div>
        <div className="border-t border-zinc-800 p-3">
          <p className="flex items-center gap-2 text-sm text-zinc-100">
            <Terminal aria-hidden className="size-4" /> Terminal
          </p>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            Each agent in its own CLI, exactly as it ships. Works with every agent.
          </p>
        </div>
      </Card>
      <Card
        label="Chat"
        selected={mode === 'chat'}
        onSelect={() => updatePreferences({ workMode: 'chat' })}
      >
        <div className="m-3 space-y-2 rounded-md border border-zinc-800 bg-black p-3 text-[11px]">
          <p className="ml-auto w-fit rounded-md bg-zinc-800 px-2 py-1 text-zinc-100">
            Add retry to fetchUser
          </p>
          <div className="rounded-md border border-zinc-800 font-mono">
            <p className="border-b border-zinc-800 px-2 py-1 text-zinc-400">
              Edited <span className="text-zinc-200">src/api.ts</span>{' '}
              <span className="text-emerald-400">+1</span> <span className="text-red-400">−1</span>
            </p>
            <p className="px-2 pt-1 text-red-400">− return fetch(url)</p>
            <p className="px-2 pb-1 text-emerald-400">+ return withRetry(fetch, url)</p>
          </div>
          <p className="text-zinc-300">Failed requests now retry up to 3 times.</p>
        </div>
        <div className="border-t border-zinc-800 p-3">
          <p className="flex items-center gap-2 text-sm text-zinc-100">
            <MessageSquare aria-hidden className="size-4" /> Chat
          </p>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            Agents answer in a conversation, with their edits shown as diffs. Claude Code, Codex and
            Antigravity; other agents open in a terminal.
          </p>
        </div>
      </Card>
    </fieldset>
  );
}

// --- Default agent and YOLO --------------------------------------------------------------------

export function AgentChoice({
  preferences,
  installed,
}: {
  preferences: Preferences;
  installed: Map<string, boolean> | undefined;
}) {
  const [all, setAll] = useState(false);
  const found = AGENT_LIST.filter((agent) => installed?.get(agent.id));
  const missing = AGENT_LIST.filter((agent) => !installed?.get(agent.id));
  const shown = all || found.length === 0 ? [...found, ...missing] : found;
  return (
    <div>
      <p className="mb-2 text-xs text-zinc-500">
        {installed === undefined
          ? 'Looking for agents on this computer…'
          : `${found.length} found on this computer`}
      </p>
      <fieldset className="min-w-0 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <legend className="sr-only">Default agent</legend>
        {shown.map((agent) => {
          const isInstalled = Boolean(installed?.get(agent.id));
          return (
            <Card
              key={agent.id}
              label={agent.label}
              selected={preferences.defaultAgent === agent.id}
              onSelect={() => updatePreferences({ defaultAgent: agent.id as AgentId })}
              className="flex-row items-center gap-3 px-3 py-2.5"
            >
              <span
                aria-hidden
                className="flex size-7 shrink-0 items-center justify-center rounded-md border border-zinc-800 font-mono text-xs"
                style={{ color: agent.accent }}
              >
                {agent.label.slice(0, 1)}
              </span>
              <span className="min-w-0 flex-1 pr-5">
                <span className="block truncate text-sm text-zinc-100">{agent.label}</span>
                <span className="block truncate font-mono text-[11px] text-zinc-500">
                  {isInstalled ? agent.command : `not installed · ${agent.command}`}
                </span>
              </span>
            </Card>
          );
        })}
      </fieldset>
      {found.length > 0 && missing.length > 0 && (
        <button
          type="button"
          onClick={() => setAll((open) => !open)}
          className="mt-2 text-xs text-zinc-500 hover:text-zinc-200"
        >
          {all ? 'Show only the ones found' : `Show ${missing.length} more agents →`}
        </button>
      )}
    </div>
  );
}

export function YoloChoice({ preferences }: { preferences: Preferences }) {
  const on = preferences.yolo;
  return (
    <div className="flex items-start gap-4 rounded-lg border border-zinc-800 p-3">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm text-zinc-100">
          {on && <TriangleAlert aria-hidden className="size-3.5 text-amber-300" />}
          YOLO mode
        </p>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">
          Agents run commands and edit files without asking, and some also leave their sandbox. Only
          for projects you trust. Off, each agent keeps its own permission settings. Applies to new
          sessions; agents without such a mode (
          {AGENT_LIST.filter((a) => !a.yolo && a.id !== 'davecode')
            .map((a) => a.label)
            .join(', ')}
          ) ask as usual.
        </p>
      </div>
      <Switch on={on} label="YOLO mode" onChange={(yolo) => updatePreferences({ yolo })} />
    </div>
  );
}

function Switch({
  on,
  label,
  onChange,
}: {
  on: boolean;
  label: string;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cn(
        'relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors',
        on ? 'border-zinc-100 bg-zinc-100' : 'border-zinc-700 bg-zinc-900',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute top-0.5 size-3.5 rounded-full transition-all',
          on ? 'left-[18px] bg-black' : 'left-0.5 bg-zinc-500',
        )}
      />
    </button>
  );
}

// --- Look ---------------------------------------------------------------------------------------

export function ColorModeChoice({ preferences }: { preferences: Preferences }) {
  return (
    <Segment<ColorMode>
      label="Color mode"
      value={preferences.colorMode}
      onChange={setColorMode}
      options={[
        { id: 'system', label: 'System', icon: <Monitor aria-hidden className="size-3.5" /> },
        { id: 'dark', label: 'Dark', icon: <Moon aria-hidden className="size-3.5" /> },
        { id: 'light', label: 'Light', icon: <Sun aria-hidden className="size-3.5" /> },
      ]}
    />
  );
}

function ThemePreview({ theme }: { theme: TerminalTheme }) {
  const c = theme.colors;
  return (
    <div
      aria-hidden
      className="h-16 rounded-t-md p-2 font-mono text-[9px] leading-[1.35]"
      style={{ background: c.background, color: c.foreground }}
    >
      <p>
        <span style={{ color: c.green }}>~/app</span> <span style={{ color: c.blue }}>main</span> ›
        npm test
      </p>
      <p>
        <span style={{ color: c.green }}>✓</span> 12 passed <span style={{ color: c.red }}>✗</span>{' '}
        1 failed
      </p>
      <p>
        <span style={{ color: c.yellow }}>warn</span>{' '}
        <span style={{ color: c.magenta }}>retry</span>{' '}
        <span style={{ color: c.cyan }}>fetchUser</span>
      </p>
    </div>
  );
}

export function TerminalThemeChoice({ preferences }: { preferences: Preferences }) {
  const active = resolvedColorMode(preferences.colorMode);
  const [tab, setTab] = useState<'dark' | 'light'>(active);
  useEffect(() => setTab(active), [active]);
  const chosen = terminalTheme(preferences.terminalTheme[tab], tab).id;
  return (
    <div>
      <Segment<'dark' | 'light'>
        label="Theme for"
        value={tab}
        onChange={setTab}
        options={[
          { id: 'dark', label: active === 'dark' ? 'Dark · now' : 'Dark' },
          { id: 'light', label: active === 'light' ? 'Light · now' : 'Light' },
        ]}
      />
      <fieldset className="mt-3 grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        <legend className="sr-only">Terminal theme for {tab} mode</legend>
        {TERMINAL_THEMES.filter((t) => t.mode === tab).map((theme) => (
          <Card
            key={theme.id}
            label={theme.label}
            selected={chosen === theme.id}
            onSelect={() =>
              updatePreferences({
                terminalTheme: { ...preferences.terminalTheme, [tab]: theme.id },
              })
            }
            className="overflow-hidden"
          >
            <ThemePreview theme={theme} />
            <span className="block truncate border-t border-zinc-800 px-2 py-1.5 text-xs text-zinc-200">
              {theme.label}
            </span>
          </Card>
        ))}
      </fieldset>
    </div>
  );
}

// --- Windows terminal --------------------------------------------------------------------------

const SHELLS: { id: Exclude<ShellId, 'auto'>; label: string; hint: string }[] = [
  { id: 'powershell', label: 'Windows PowerShell', hint: 'In every Windows installation.' },
  { id: 'pwsh', label: 'PowerShell 7', hint: 'The newer, cross-platform PowerShell.' },
  { id: 'cmd', label: 'Command Prompt', hint: 'The classic cmd.exe.' },
  { id: 'gitbash', label: 'Git Bash', hint: 'Bash from Git for Windows, for Unix-style work.' },
  {
    id: 'wsl',
    label: 'WSL',
    hint: 'Your default Linux distribution. Agents must be installed in it.',
  },
];

export function ShellChoice({
  preferences,
  installed,
}: {
  preferences: Preferences;
  installed: Map<string, boolean> | undefined;
}) {
  // `auto` means PowerShell 7 when present, else Windows PowerShell: show that one as chosen.
  const effective =
    preferences.shell === 'auto'
      ? installed?.get('pwsh')
        ? 'pwsh'
        : 'powershell'
      : preferences.shell;
  return (
    <fieldset className="min-w-0 grid gap-2 sm:grid-cols-2">
      <legend className="sr-only">Default shell</legend>
      {SHELLS.map((shell) => {
        const present =
          installed === undefined ? shell.id === 'powershell' : Boolean(installed.get(shell.id));
        return (
          <Card
            key={shell.id}
            label={shell.label}
            selected={effective === shell.id}
            disabled={!present}
            onSelect={() => updatePreferences({ shell: shell.id })}
            className="px-3 py-2.5"
          >
            <span className="pr-6 text-sm text-zinc-100">{shell.label}</span>
            <span className="mt-0.5 text-xs leading-relaxed text-zinc-500">
              {present ? shell.hint : 'Not found on this computer.'}
            </span>
          </Card>
        );
      })}
    </fieldset>
  );
}

export function RightClickChoice({ preferences }: { preferences: Preferences }) {
  return (
    <div>
      <Segment<'paste' | 'menu'>
        label="Right click in a terminal"
        value={preferences.rightClick}
        onChange={(rightClick) => updatePreferences({ rightClick })}
        options={[
          { id: 'paste', label: 'Copy or paste' },
          { id: 'menu', label: 'Open a menu' },
        ]}
      />
      <p className="mt-2 text-xs text-zinc-500">
        {preferences.rightClick === 'paste'
          ? 'Right click copies the selection, or pastes when nothing is selected. Ctrl + right click opens the menu.'
          : 'Right click opens a menu with copy, paste, select all and clear.'}
      </p>
    </div>
  );
}

// --- Notifications -----------------------------------------------------------------------------

export function NotificationChoice({ preferences }: { preferences: Preferences }) {
  const { enabled, sound } = preferences.notifications;
  const set = (patch: Partial<Preferences['notifications']>) =>
    updatePreferences({ notifications: { ...preferences.notifications, ...patch } });
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-4 rounded-lg border border-zinc-800 p-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm text-zinc-100">
            <Bell aria-hidden className="size-3.5" /> Notify me
          </p>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            When an agent finishes or asks for you while you look elsewhere, and when an
            orchestrator run ends.
          </p>
        </div>
        <Switch on={enabled} label="Notifications" onChange={(on) => set({ enabled: on })} />
      </div>
      <div className={cn('flex flex-wrap items-center gap-2', !enabled && 'opacity-40')}>
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          Sound
          <select
            aria-label="Notification sound"
            value={sound}
            disabled={!enabled}
            onChange={(event) => {
              const next = event.target.value as SoundId;
              set({ sound: next });
              playSound(next);
            }}
            className="h-8 rounded-md border border-zinc-800 bg-black px-2 text-xs text-zinc-100 outline-none hover:border-zinc-600 focus:border-zinc-500"
          >
            {SOUND_IDS.map((id) => (
              <option key={id} value={id}>
                {SOUND_LABEL[id]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!enabled}
          onClick={testNotification}
          className="flex h-8 items-center gap-1.5 rounded-md border border-zinc-800 px-3 text-xs text-zinc-200 hover:border-zinc-600 disabled:pointer-events-none"
        >
          <Bell aria-hidden className="size-3.5" /> Send a test notification
        </button>
      </div>
    </div>
  );
}
