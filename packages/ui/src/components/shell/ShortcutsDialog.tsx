import { SHORTCUT_GROUPS } from '../../lib/shortcuts';
import { ui, useUi } from '../../lib/ui-state';
import { Keys, modKey } from '../ui/Kbd';
import { Dialog } from '../ui/Overlay';

export function ShortcutsDialog() {
  const { help } = useUi();
  return (
    <Dialog
      open={help}
      onClose={ui.closeHelp}
      title="Keyboard shortcuts"
      description="DaveCode is keyboard-first. Shortcuts are paused while you type in a field."
      className="w-[min(560px,calc(100vw-2rem))]"
    >
      <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.title} aria-labelledby={`sc-${group.title}`}>
            <h3 id={`sc-${group.title}`} className="eyebrow mb-2">
              {group.title}
            </h3>
            <dl className="flex flex-col gap-1.5">
              {group.items.map((item) => (
                <div
                  key={item.description}
                  className="flex items-center justify-between gap-3 text-[13px]"
                >
                  <dt className="text-fg-2">{item.description}</dt>
                  <dd>
                    <Keys keys={item.keys.map((k) => (k === 'mod' ? modKey : k))} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
