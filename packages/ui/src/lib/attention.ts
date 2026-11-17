/**
 * When a terminal wants the person: an agent that worked for a while and went quiet is waiting
 * for them, and a terminal can also say so itself with a bell or a notification escape
 * sequence. Pure, so the rules can be tested without a terminal.
 */

/** Silence after output that counts as the work having stopped. */
export const IDLE_MS = 2500;
/** Only work that went on at least this long is worth a notification when it stops. */
export const MIN_BUSY_MS = 5000;

/** A message a terminal asked to show (OSC 9 or OSC 777), or a plain bell. */
export interface TerminalSignal {
  message?: string | undefined;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences are control characters
const OSC = /\x1b\](9|777);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/** Notification requests and bells in one chunk of terminal output. */
export function scanSignals(data: string): TerminalSignal[] {
  const signals: TerminalSignal[] = [];
  for (const match of data.matchAll(OSC)) {
    const [, code, body = ''] = match;
    if (code === '9') {
      // `OSC 9;4;…` is a progress bar (Windows Terminal, ConEmu), not a notification.
      if (/^\d+;/.test(body)) continue;
      signals.push({ message: body.trim() || undefined });
    } else {
      const [kind, title = '', text = ''] = body.split(';');
      if (kind !== 'notify') continue;
      signals.push({ message: [title, text].filter(Boolean).join(': ').trim() || undefined });
    }
  }
  // A bell that is not the end of an escape sequence is a bell of its own.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences are control characters
  const rest = data.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  if (rest.includes('\x07')) signals.push({});
  return signals;
}

/** Tracks one terminal's output and says once when a long stretch of work has stopped. */
export class ActivityTracker {
  private burstStart: number | undefined;
  private lastOutput: number | undefined;
  private reported = false;

  output(now: number): void {
    if (this.lastOutput === undefined || now - this.lastOutput > IDLE_MS) {
      this.burstStart = now;
      this.reported = false;
    }
    this.lastOutput = now;
  }

  /** True exactly once after a stretch of work of at least {@link MIN_BUSY_MS} went quiet. */
  settled(now: number): boolean {
    if (this.reported || this.lastOutput === undefined || this.burstStart === undefined) {
      return false;
    }
    if (now - this.lastOutput < IDLE_MS) return false;
    if (this.lastOutput - this.burstStart < MIN_BUSY_MS) return false;
    this.reported = true;
    return true;
  }
}
