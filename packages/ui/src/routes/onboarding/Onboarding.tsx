import { ArrowLeft } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { BrandMark } from '../../components/shell/Sidebar';
import { cn } from '../../lib/cn';
import { desktopPlatform } from '../../lib/desktop';
import { requestFirstSession } from '../../lib/first-session';
import { updatePreferences, usePreferences } from '../../lib/preferences';
import {
  AgentChoice,
  ColorModeChoice,
  NotificationChoice,
  RightClickChoice,
  SectionTitle,
  ShellChoice,
  TerminalThemeChoice,
  useInstalled,
  WorkModeChoice,
  YoloChoice,
} from './choices';

type Step = 'mode' | 'agent' | 'look' | 'shell' | 'notify';

/**
 * The first-run setup of the desktop app: where agents open, which one is the default, how it
 * looks, the Windows shell, and notifications. Every choice applies at once and can be changed
 * later in Settings; "Set up later" keeps the defaults.
 */
export function Onboarding() {
  const preferences = usePreferences();
  const windows = desktopPlatform() === 'win32';
  const steps: Step[] = [
    'mode',
    'agent',
    'look',
    ...(windows ? (['shell'] as const) : []),
    'notify',
  ];
  const [index, setIndex] = useState(0);
  const step = steps[index] ?? 'mode';
  const agents = useInstalled('agents');
  const shells = useInstalled('shells');
  const last = index === steps.length - 1;

  const finish = useCallback(
    (completed: boolean) => {
      // Finishing opens the chosen agent right away; skipping opens a plain shell.
      if (completed) requestFirstSession(preferences.defaultAgent);
      updatePreferences({ onboarded: true });
    },
    [preferences.defaultAgent],
  );
  const next = useCallback(() => {
    if (last) finish(true);
    else setIndex((i) => i + 1);
  }, [last, finish]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        next();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next]);

  return (
    <div className="ws-invert fixed inset-0 z-30 flex flex-col bg-black font-sans text-zinc-100">
      <header className="flex h-16 shrink-0 items-center gap-2.5 px-8">
        <BrandMark className="size-6" />
        <span className="text-sm font-medium">DaveCode</span>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto px-8">
        <div className="mx-auto w-full max-w-4xl pb-10">
          <div className="mb-8 flex items-center gap-3">
            <span className="sr-only">
              Step {index + 1} of {steps.length}
            </span>
            <div className="flex gap-1.5">
              {steps.map((s, i) => (
                <span
                  key={s}
                  aria-hidden
                  className={cn(
                    'h-0.5 w-8 rounded-full',
                    i === index ? 'bg-zinc-100' : i < index ? 'bg-zinc-500' : 'bg-zinc-800',
                  )}
                />
              ))}
            </div>
            <span className="font-mono text-[11px] text-zinc-500">
              {index + 1} / {steps.length}
            </span>
          </div>
          {step === 'mode' && (
            <StepBody
              eyebrow="Welcome to DaveCode"
              title="How do you want to work with agents?"
              subtitle="Pick where new agents open. You can switch any time in Settings."
            >
              <WorkModeChoice preferences={preferences} />
            </StepBody>
          )}
          {step === 'agent' && (
            <StepBody
              title="Pick your default agent"
              subtitle="DaveCode runs the agent CLIs you already use, each with its own login. Choose the one you reach for most; open any other from the sidebar."
            >
              <AgentChoice preferences={preferences} installed={agents} />
              <div className="mt-6">
                <YoloChoice preferences={preferences} />
              </div>
            </StepBody>
          )}
          {step === 'look' && (
            <StepBody title="Make it yours" subtitle="Change any of it later in Settings.">
              <SectionTitle>Color mode</SectionTitle>
              <ColorModeChoice preferences={preferences} />
              <div className="mt-6">
                <SectionTitle hint="One for dark mode and one for light mode; the color mode picks which.">
                  Terminal theme
                </SectionTitle>
                <TerminalThemeChoice preferences={preferences} />
              </div>
            </StepBody>
          )}
          {step === 'shell' && (
            <StepBody
              title="Set up the Windows terminal"
              subtitle="The shell new sessions open in, and what a right click does."
            >
              <SectionTitle>Default shell</SectionTitle>
              <ShellChoice preferences={preferences} installed={shells} />
              <div className="mt-6">
                <SectionTitle>Right click</SectionTitle>
                <RightClickChoice preferences={preferences} />
              </div>
            </StepBody>
          )}
          {step === 'notify' && (
            <StepBody
              title="Notifications"
              subtitle="DaveCode tells you when an agent finishes or needs you, so you can look elsewhere meanwhile."
            >
              <NotificationChoice preferences={preferences} />
            </StepBody>
          )}
        </div>
      </main>
      <footer className="flex h-16 shrink-0 items-center gap-2 border-t border-zinc-800 px-8">
        <button
          type="button"
          onClick={() => finish(false)}
          className="text-sm text-zinc-500 hover:text-zinc-200"
        >
          Set up later
        </button>
        <span className="ml-auto" />
        {index > 0 && (
          <button
            type="button"
            onClick={() => setIndex((i) => i - 1)}
            className="flex h-9 items-center gap-1.5 rounded-md border border-zinc-800 px-3 text-sm text-zinc-200 hover:border-zinc-600"
          >
            <ArrowLeft aria-hidden className="size-3.5" /> Back
          </button>
        )}
        <button
          type="button"
          onClick={next}
          className="flex h-9 items-center gap-2 rounded-md bg-zinc-100 px-4 text-sm font-medium text-black hover:bg-white"
        >
          {last ? 'Start' : 'Continue'}
          <kbd className="rounded border border-zinc-400 px-1 font-mono text-[10px] text-zinc-600">
            Ctrl ↵
          </kbd>
        </button>
      </footer>
    </div>
  );
}

function StepBody({
  eyebrow,
  title,
  subtitle,
  children,
}: {
  eyebrow?: string;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section>
      {eyebrow && (
        <p className="mb-2 font-mono text-[11px] tracking-wider text-zinc-500 uppercase">
          {eyebrow}
        </p>
      )}
      <h1 className="text-3xl font-semibold tracking-tight text-zinc-100">{title}</h1>
      <p className="mt-2 mb-8 max-w-2xl text-sm leading-relaxed text-zinc-500">{subtitle}</p>
      {children}
    </section>
  );
}
