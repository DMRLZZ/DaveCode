/**
 * Terminal styling: one accent colour plus semantic colours, with plain-text fallbacks for
 * `NO_COLOR`, `--no-color`, non-TTY output and terminals without Unicode glyphs.
 */

export interface ColorStream {
  isTTY?: boolean;
}

/**
 * Colour is on for TTYs unless `NO_COLOR` is set (any value) or `--no-color` was passed.
 * `FORCE_COLOR` (anything but `0`/`false`) turns it on even when piped.
 */
export function detectColor(
  env: NodeJS.ProcessEnv,
  stream: ColorStream,
  flag: boolean | undefined = undefined,
): boolean {
  if (flag === false) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  const force = env.FORCE_COLOR;
  if (force !== undefined) return !['0', 'false'].includes(force.trim().toLowerCase());
  if (env.TERM === 'dumb') return false;
  return stream.isTTY === true;
}

/**
 * Heuristic from `is-unicode-supported`: every non-Windows terminal except the Linux console,
 * and the Windows terminals known to render box-drawing and braille glyphs.
 */
export function detectUnicode(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (env.DAVECODE_ASCII === '1') return false;
  if (platform !== 'win32') return env.TERM !== 'linux';
  return (
    Boolean(env.WT_SESSION) ||
    Boolean(env.TERMINUS_SUBLIME) ||
    env.ConEmuTask === '{cmd::Cmder}' ||
    env.TERM_PROGRAM === 'vscode' ||
    env.TERM_PROGRAM === 'Terminus-Sublime' ||
    env.TERM === 'xterm-256color' ||
    env.TERM === 'alacritty' ||
    env.TERMINAL_EMULATOR === 'JetBrains-JediTerm' ||
    Boolean(env.CI)
  );
}

export interface Glyphs {
  ok: string;
  fail: string;
  warn: string;
  info: string;
  bullet: string;
  arrow: string;
  dot: string;
  ellipsis: string;
  prompt: string;
  /** Task statuses. */
  pending: string;
  running: string;
  success: string;
  failed: string;
  blocked: string;
  /** Tree connectors (`tee` = has siblings below, `elbow` = last child). */
  tee: string;
  elbow: string;
  pipe: string;
  /** Quota bars. */
  barFull: string;
  barEmpty: string;
  /** Horizontal rule. */
  rule: string;
}

const UNICODE_GLYPHS: Glyphs = {
  ok: '✓',
  fail: '✗',
  warn: '!',
  info: 'i',
  bullet: '•',
  arrow: '→',
  dot: '●',
  ellipsis: '…',
  prompt: '›',
  pending: '○',
  running: '◐',
  success: '●',
  failed: '✗',
  blocked: '◌',
  tee: '├─',
  elbow: '└─',
  pipe: '│ ',
  barFull: '█',
  barEmpty: '░',
  rule: '─',
};

const ASCII_GLYPHS: Glyphs = {
  ok: 'ok',
  fail: 'x',
  warn: '!',
  info: 'i',
  bullet: '*',
  arrow: '->',
  dot: '*',
  ellipsis: '...',
  prompt: '>',
  pending: 'o',
  running: '~',
  success: '*',
  failed: 'x',
  blocked: '-',
  tee: '|-',
  elbow: '`-',
  pipe: '| ',
  barFull: '#',
  barEmpty: '.',
  rule: '-',
};

type Style = (text: string) => string;

export interface Theme {
  color: boolean;
  unicode: boolean;
  glyph: Glyphs;
  /** The one brand colour: headings, ids, the active element. */
  accent: Style;
  ok: Style;
  warn: Style;
  error: Style;
  /** Secondary information. */
  dim: Style;
  bold: Style;
  /** Ink `<Text color>` values (undefined when colour is off). */
  ink: {
    accent: string | undefined;
    ok: string | undefined;
    warn: string | undefined;
    error: string | undefined;
    dim: boolean;
  };
}

/** Accent: a calm teal from the 256-colour palette (supported by every modern terminal). */
const ACCENT_256 = 80;
const ACCENT_HEX = '#5fd7d7';

function sgr(open: string, close: string): Style {
  return (text) => (text === '' ? text : `\u001b[${open}m${text}\u001b[${close}m`);
}

const identity: Style = (text) => text;

export function createTheme(options: { color: boolean; unicode: boolean }): Theme {
  const { color, unicode } = options;
  const glyph = unicode ? UNICODE_GLYPHS : ASCII_GLYPHS;
  if (!color) {
    return {
      color,
      unicode,
      glyph,
      accent: identity,
      ok: identity,
      warn: identity,
      error: identity,
      dim: identity,
      bold: identity,
      ink: { accent: undefined, ok: undefined, warn: undefined, error: undefined, dim: false },
    };
  }
  return {
    color,
    unicode,
    glyph,
    accent: sgr(`38;5;${ACCENT_256}`, '39'),
    ok: sgr('32', '39'),
    warn: sgr('33', '39'),
    error: sgr('31', '39'),
    dim: sgr('2', '22'),
    bold: sgr('1', '22'),
    ink: { accent: ACCENT_HEX, ok: 'green', warn: 'yellow', error: 'red', dim: true },
  };
}

/** Theme for a stream given the environment and the `--color/--no-color` flag. */
export function themeFor(
  env: NodeJS.ProcessEnv,
  stream: ColorStream,
  colorFlag?: boolean,
  platform: NodeJS.Platform = process.platform,
): Theme {
  return createTheme({
    color: detectColor(env, stream, colorFlag),
    unicode: detectUnicode(env, platform),
  });
}

/** A theme with no styling, for tests and `--json`. */
export const PLAIN_THEME: Theme = createTheme({ color: false, unicode: true });
