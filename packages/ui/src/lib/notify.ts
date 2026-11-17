import { type DesktopNotification, desktopNotify } from './desktop';
import { getPreferences } from './preferences';
import { playSound } from './sounds';

/** Shortest time between two notifications about the same thing. */
const REPEAT_MS = 10_000;
const lastShown = new Map<string, number>();

/**
 * Tells the person something happened: a system notification and the chosen sound, when
 * notifications are on. `key` keeps one source from notifying more than once in a few seconds.
 */
export function notifyUser(key: string, notification: DesktopNotification, now = Date.now()): void {
  const { notifications } = getPreferences();
  if (!notifications.enabled) return;
  const last = lastShown.get(key);
  if (last !== undefined && now - last < REPEAT_MS) return;
  lastShown.set(key, now);
  void desktopNotify(notification);
  playSound(notifications.sound);
}

/** A test from the settings: always shown, whatever was shown before. */
export function testNotification(): void {
  void desktopNotify({ title: 'DaveCode', body: 'Notifications are on. This is how they look.' });
  playSound(getPreferences().notifications.sound);
}
