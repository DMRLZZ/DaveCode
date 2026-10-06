import { describe, expect, it, vi } from 'vitest';
import { EventBus } from './events';

describe('EventBus', () => {
  it('stamps events and delivers them to subscribers', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.subscribe(handler);

    const event = bus.emit({ type: 'log', level: 'info', scope: 'test', message: 'hello' });

    expect(event.ts).toBeTypeOf('number');
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const off = bus.subscribe(handler);
    off();
    bus.emit({ type: 'log', level: 'info', scope: 'test', message: 'ignored' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps a bounded replay buffer', () => {
    const bus = new EventBus(3);
    for (let i = 0; i < 5; i++) {
      bus.emit({ type: 'log', level: 'debug', scope: 'test', message: String(i) });
    }
    const messages = bus.recent().map((e) => (e.type === 'log' ? e.message : ''));
    expect(messages).toEqual(['2', '3', '4']);
  });

  it('isolates subscribers that throw', () => {
    const bus = new EventBus();
    const good = vi.fn();
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe(good);
    bus.emit({ type: 'log', level: 'warn', scope: 'test', message: 'still delivered' });
    expect(good).toHaveBeenCalledOnce();
  });
});
