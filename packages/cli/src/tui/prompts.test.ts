import { render } from 'ink-testing-library';
import { createElement as h } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmPrompt, SelectPrompt, sanitizeLine, TextPrompt } from './prompts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('Ink prompts', () => {
  it('masks secrets while typing and after submitting', async () => {
    const done = vi.fn();
    const ui = render(h(TextPrompt, { message: 'API key', mask: true, done, cancel: vi.fn() }));
    await tick();
    ui.stdin.write('sk-secret');
    await tick();
    expect(ui.lastFrame()).not.toContain('sk-secret');
    expect(ui.lastFrame()).toContain('•••••••••');
    ui.stdin.write('\r');
    await tick();
    expect(done).toHaveBeenCalledWith('sk-secret');
    expect(ui.lastFrame()).toContain('API key set');
    expect(ui.frames.join('')).not.toContain('sk-secret');
    ui.unmount();
  });

  it('validates text input before submitting', async () => {
    const done = vi.fn();
    const ui = render(
      h(TextPrompt, {
        message: 'Priority',
        validate: (v: string) => (/^\d+$/.test(v) ? undefined : 'enter a number'),
        done,
        cancel: vi.fn(),
      }),
    );
    await tick();
    ui.stdin.write('abc');
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(done).not.toHaveBeenCalled();
    expect(ui.lastFrame()).toContain('enter a number');
    ui.unmount();
  });

  it('moves the selection with arrow keys and submits with Enter', async () => {
    const done = vi.fn();
    const ui = render(
      h(SelectPrompt<string>, {
        message: 'Provider',
        choices: [
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta', hint: 'second' },
        ],
        done,
        cancel: vi.fn(),
      }),
    );
    await tick();
    expect(ui.lastFrame()).toContain('› Alpha');
    ui.stdin.write('\u001b[B');
    await tick();
    expect(ui.lastFrame()).toContain('› Beta');
    ui.stdin.write('\r');
    await tick();
    expect(done).toHaveBeenCalledWith('b');
    ui.unmount();
  });

  it('cancels on Escape and answers confirmations with y/n', async () => {
    const cancel = vi.fn();
    const done = vi.fn();
    const ui = render(h(ConfirmPrompt, { message: 'Continue?', initial: false, done, cancel }));
    await tick();
    expect(ui.lastFrame()).toContain('(y/N)');
    ui.stdin.write('y');
    await tick();
    expect(done).toHaveBeenCalledWith(true);
    ui.unmount();

    const select = render(
      h(SelectPrompt<string>, {
        message: 'x',
        choices: [{ value: 'a', label: 'A' }],
        done,
        cancel,
      }),
    );
    await tick();
    select.stdin.write('\u001b');
    await tick();
    await tick();
    expect(cancel).toHaveBeenCalled();
    select.unmount();
  });

  it('strips control characters from pasted single-line input', () => {
    expect(sanitizeLine('sk-abc\r\n')).toBe('sk-abc');
  });
});
