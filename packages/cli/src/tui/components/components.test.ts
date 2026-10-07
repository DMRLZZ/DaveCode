import { render } from 'ink-testing-library';
import { createElement as h } from 'react';
import { describe, expect, it } from 'vitest';
import { plain } from '../../test-utils';
import { initialChatState } from '../chat-state';
import * as ed from '../editor';
import { SLASH_COMMANDS } from '../slash';
import { ThemeProvider } from '../theme-context';
import { cursorParts, InputBox, SlashHints } from './InputBox';
import { StatusLine } from './StatusLine';
import { EntryView, StreamingView } from './Transcript';

const themed = (child: ReturnType<typeof h>) => h(ThemeProvider, { theme: plain }, child);

describe('InputBox', () => {
  it('shows the placeholder when empty and the text with a cursor otherwise', () => {
    const empty = render(
      themed(h(InputBox, { editor: ed.emptyEditor, width: 60, placeholder: 'Ask anything' })),
    );
    expect(empty.lastFrame()).toContain('› ');
    expect(empty.lastFrame()).toContain('Ask anything');
    expect(empty.lastFrame()).toContain('╭');
    empty.unmount();

    const filled = render(
      themed(
        h(InputBox, { editor: ed.fromText('line one\nline two'), width: 60, placeholder: 'x' }),
      ),
    );
    const frame = filled.lastFrame() ?? '';
    expect(frame).toContain('› line one');
    expect(frame).toContain('  line two');
    expect(frame).not.toContain('x ');
    filled.unmount();
  });

  it('splits a line around the cursor', () => {
    expect(cursorParts([...'abc'], 1)).toEqual({ before: 'a', at: 'b', after: 'c' });
    expect(cursorParts([...'abc'], 3)).toEqual({ before: 'abc', at: ' ', after: '' });
    expect(cursorParts([...'abc'], undefined)).toEqual({ before: 'abc', at: '', after: '' });
  });

  it('lists slash suggestions', () => {
    const ui = render(themed(h(SlashHints, { commands: SLASH_COMMANDS.slice(0, 2), width: 80 })));
    expect(ui.lastFrame()).toContain('/model [id]');
    expect(ui.lastFrame()).toContain('routes and their failover targets');
    ui.unmount();
  });
});

describe('transcript entries', () => {
  it('renders user, assistant (with meta), info and error entries', () => {
    const entries = [
      { id: 1, kind: 'user' as const, text: 'Explain this' },
      {
        id: 2,
        kind: 'assistant' as const,
        text: 'Sure.',
        meta: { provider: 'anthropic', accountLabel: 'work', tokens: 42, latencyMs: 1200 },
      },
      { id: 3, kind: 'error' as const, text: 'no_capacity' },
    ];
    const frames = entries.map((entry) => {
      const ui = render(themed(h(EntryView, { entry })));
      const frame = ui.lastFrame() ?? '';
      ui.unmount();
      return frame;
    });
    expect(frames[0]).toContain('› Explain this');
    expect(frames[1]).toContain('● Sure.');
    expect(frames[1]).toContain('anthropic · work · 42 tok · 1.2s');
    expect(frames[2]).toContain('✗ no_capacity');
  });

  it('shows a spinner while waiting for the first token', () => {
    const ui = render(
      themed(
        h(StreamingView, {
          streaming: { id: 1, text: '', startedAt: 0, model: 'davecode/auto' },
          now: 3000,
        }),
      ),
    );
    expect(ui.lastFrame()).toContain('thinking 3s · esc to cancel');
    ui.unmount();
  });
});

describe('StatusLine', () => {
  it('renders both sides of the status bar', () => {
    const state = {
      ...initialChatState('davecode/auto'),
      connection: 'online' as const,
      lastAccount: { id: 'acc_1', label: 'work' },
    };
    const ui = render(
      themed(
        h(StatusLine, {
          state,
          width: 100,
          info: { where: 'http://127.0.0.1:4040', inProcess: false },
        }),
      ),
    );
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('davecode/auto · work · 0 failovers');
    expect(frame).toContain('● connected');
    ui.unmount();
  });
});
