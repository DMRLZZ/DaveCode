import { describe, expect, it } from 'vitest';
import { ActivityTracker, IDLE_MS, MIN_BUSY_MS, scanSignals } from './attention';

describe('scanSignals', () => {
  it('finds OSC 9 and OSC 777 notifications', () => {
    expect(scanSignals('before\x1b]9;Codex is done\x07after')).toEqual([
      { message: 'Codex is done' },
    ]);
    expect(scanSignals('\x1b]9;Waiting\x1b\\')).toEqual([{ message: 'Waiting' }]);
    expect(scanSignals('\x1b]777;notify;Claude;Needs input\x07')).toEqual([
      { message: 'Claude: Needs input' },
    ]);
  });

  it('finds a bell of its own but not one that ends an escape sequence', () => {
    expect(scanSignals('done\x07')).toEqual([{}]);
    // A window title change ends with a bell too.
    expect(scanSignals('\x1b]0;my title\x07')).toEqual([]);
    expect(scanSignals('\x1b]0;title\x07 and \x07')).toEqual([{}]);
  });

  it('ignores progress bars and other sequences', () => {
    expect(scanSignals('\x1b]9;4;1;50\x07')).toEqual([]);
    expect(scanSignals('\x1b]777;preexec\x07')).toEqual([]);
    expect(scanSignals('\x1b[31mred\x1b[0m')).toEqual([]);
  });
});

describe('ActivityTracker', () => {
  const feed = (tracker: ActivityTracker, from: number, to: number, every = 200) => {
    for (let t = from; t <= to; t += every) tracker.output(t);
  };

  it('says once when long work goes quiet', () => {
    const tracker = new ActivityTracker();
    feed(tracker, 0, MIN_BUSY_MS + 1000);
    const last = MIN_BUSY_MS + 1000;
    expect(tracker.settled(last + 500)).toBe(false);
    expect(tracker.settled(last + IDLE_MS)).toBe(true);
    expect(tracker.settled(last + IDLE_MS + 5000)).toBe(false);
  });

  it('ignores short bursts such as typing or a redraw', () => {
    const tracker = new ActivityTracker();
    feed(tracker, 0, 1500);
    expect(tracker.settled(1500 + IDLE_MS + 100)).toBe(false);
  });

  it('starts over with the next stretch of work', () => {
    const tracker = new ActivityTracker();
    feed(tracker, 0, MIN_BUSY_MS);
    expect(tracker.settled(MIN_BUSY_MS + IDLE_MS)).toBe(true);
    const next = MIN_BUSY_MS + IDLE_MS + 10_000;
    feed(tracker, next, next + MIN_BUSY_MS);
    expect(tracker.settled(next + MIN_BUSY_MS + IDLE_MS)).toBe(true);
  });

  it('has nothing to say before any output', () => {
    expect(new ActivityTracker().settled(100_000)).toBe(false);
  });
});
