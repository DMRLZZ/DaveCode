import { describe, expect, it } from 'vitest';
import { ascii, plain } from '../test-utils';
import {
  bar,
  formatDuration,
  formatTokens,
  percent,
  stripAnsi,
  table,
  truncate,
  visibleWidth,
} from './format';
import { createTheme, detectColor, detectUnicode } from './theme';

describe('format helpers', () => {
  it('formats token counts compactly', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_300)).toBe('12.3k');
    expect(formatTokens(2000)).toBe('2k');
    expect(formatTokens(4_500_000)).toBe('4.5M');
  });

  it('formats durations', () => {
    expect(formatDuration(42)).toBe('42s');
    expect(formatDuration(125)).toBe('2m 5s');
    expect(formatDuration(3725)).toBe('1h 2m');
    expect(formatDuration(90_061)).toBe('1d 1h');
  });

  it('formats percentages and truncates text', () => {
    expect(percent(0.234)).toBe('23%');
    expect(percent(1.04)).toBe('104%');
    expect(percent(Number.NaN)).toBe('0%');
    expect(truncate('abcdefgh', 5)).toBe('abcd…');
    expect(truncate('abc', 5)).toBe('abc');
  });

  it('draws quota bars with a minimum of one filled cell', () => {
    expect(bar(plain, 0.5, 10)).toBe('█████░░░░░');
    expect(bar(plain, 0.01, 10)).toBe('█░░░░░░░░░');
    expect(bar(plain, 2, 4)).toBe('████');
    expect(bar(ascii, 0.25, 4)).toBe('#...');
    expect(bar(plain, 0, 4, false)).toBe('░░░░');
  });

  it('measures width without ANSI codes', () => {
    const colored = createTheme({ color: true, unicode: true }).accent('hello');
    expect(colored).not.toBe('hello');
    expect(stripAnsi(colored)).toBe('hello');
    expect(visibleWidth(colored)).toBe(5);
  });

  it('aligns tables and drops low-priority columns when narrow', () => {
    const columns = [
      { header: 'ID' },
      { header: 'NAME' },
      { header: 'EXTRA', drop: 1 },
      { header: 'N', align: 'right' as const },
    ];
    const rows = [
      ['a', 'alpha', 'xxxxxxxxxxxx', '1'],
      ['bb', 'beta', 'y', '22'],
    ];
    expect(table(plain, columns, rows)).toEqual([
      'ID  NAME   EXTRA          N',
      'a   alpha  xxxxxxxxxxxx   1',
      'bb  beta   y             22',
    ]);
    expect(table(plain, columns, rows, 20)).toEqual([
      'ID  NAME    N',
      'a   alpha   1',
      'bb  beta   22',
    ]);
  });
});

describe('theme detection', () => {
  it('honours NO_COLOR, FORCE_COLOR, TERM=dumb and TTY state', () => {
    expect(detectColor({}, { isTTY: true })).toBe(true);
    expect(detectColor({}, { isTTY: false })).toBe(false);
    expect(detectColor({ NO_COLOR: '1' }, { isTTY: true })).toBe(false);
    expect(detectColor({ FORCE_COLOR: '1' }, { isTTY: false })).toBe(true);
    expect(detectColor({ FORCE_COLOR: '0' }, { isTTY: true })).toBe(false);
    expect(detectColor({ TERM: 'dumb' }, { isTTY: true })).toBe(false);
    expect(detectColor({}, { isTTY: true }, false)).toBe(false);
  });

  it('uses ASCII glyphs on legacy Windows consoles only', () => {
    expect(detectUnicode({}, 'linux')).toBe(true);
    expect(detectUnicode({ TERM: 'linux' }, 'linux')).toBe(false);
    expect(detectUnicode({}, 'win32')).toBe(false);
    expect(detectUnicode({ WT_SESSION: 'abc' }, 'win32')).toBe(true);
    expect(detectUnicode({ TERM_PROGRAM: 'vscode' }, 'win32')).toBe(true);
    expect(detectUnicode({ DAVECODE_ASCII: '1' }, 'darwin')).toBe(false);
  });
});
