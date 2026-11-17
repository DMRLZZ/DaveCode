import { Panel, PanelHeader } from '../components/ui/Panel';
import { desktopPlatform, preferencesBridge } from '../lib/desktop';
import { useInstalled } from '../lib/installed';
import { updatePreferences, usePreferences } from '../lib/preferences';
import {
  AgentChoice,
  NotificationChoice,
  RightClickChoice,
  SectionTitle,
  ShellChoice,
  TerminalThemeChoice,
  WorkModeChoice,
  YoloChoice,
} from './onboarding/choices';

/**
 * The choices of the first-run setup, to change later. Only in the desktop app: the browser
 * dashboard has no terminals or agents of its own.
 */
export function WorkspaceSettings() {
  const preferences = usePreferences();
  const agents = useInstalled('agents');
  const shells = useInstalled('shells');
  if (!preferencesBridge()) return null;
  const windows = desktopPlatform() === 'win32';
  return (
    <Panel aria-labelledby="workspace-title">
      <PanelHeader id="workspace-title" title="Workspace" />
      {/* The choices are drawn like the workspace, so they follow its light mode too. */}
      <div className="ws-invert space-y-8 bg-black p-4 text-zinc-100">
        <section>
          <SectionTitle hint="Where new agents open.">Work mode</SectionTitle>
          <WorkModeChoice preferences={preferences} />
        </section>
        <section>
          <SectionTitle hint="Opened by New, Ctrl+Shift+T and the first session; it also leads orchestrator runs when it can.">
            Default agent
          </SectionTitle>
          <AgentChoice preferences={preferences} installed={agents} />
          <div className="mt-4">
            <YoloChoice preferences={preferences} />
          </div>
        </section>
        <section>
          <SectionTitle hint="The color mode is under Appearance.">Terminal theme</SectionTitle>
          <TerminalThemeChoice preferences={preferences} />
        </section>
        {windows && (
          <section>
            <SectionTitle hint="For new sessions.">Default shell</SectionTitle>
            <ShellChoice preferences={preferences} installed={shells} />
          </section>
        )}
        <section>
          <SectionTitle>Right click in a terminal</SectionTitle>
          <RightClickChoice preferences={preferences} />
        </section>
        <section>
          <SectionTitle>Notifications</SectionTitle>
          <NotificationChoice preferences={preferences} />
        </section>
        <section>
          <SectionTitle hint="Shows the first-run setup again the next time the terminals open.">
            First-run setup
          </SectionTitle>
          <button
            type="button"
            onClick={() => updatePreferences({ onboarded: false })}
            className="h-8 rounded-md border border-zinc-800 px-3 text-xs text-zinc-200 hover:border-zinc-600"
          >
            Run the setup again
          </button>
        </section>
      </div>
    </Panel>
  );
}
