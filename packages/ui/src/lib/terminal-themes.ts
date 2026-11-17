/**
 * Color themes for the terminal panes, in the shape xterm.js takes. Each one is dark or light;
 * the person picks one of each and the color mode decides which is used.
 */

export interface TerminalTheme {
  id: string;
  label: string;
  mode: 'dark' | 'light';
  colors: {
    background: string;
    foreground: string;
    cursor: string;
    selectionBackground: string;
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
  };
}

type Palette = [string, string, string, string, string, string, string, string];

function theme(
  id: string,
  label: string,
  mode: 'dark' | 'light',
  base: { background: string; foreground: string; cursor: string; selection: string },
  normal: Palette,
  bright: Palette,
): TerminalTheme {
  const [black, red, green, yellow, blue, magenta, cyan, white] = normal;
  const [bBlack, bRed, bGreen, bYellow, bBlue, bMagenta, bCyan, bWhite] = bright;
  return {
    id,
    label,
    mode,
    colors: {
      background: base.background,
      foreground: base.foreground,
      cursor: base.cursor,
      selectionBackground: base.selection,
      black,
      red,
      green,
      yellow,
      blue,
      magenta,
      cyan,
      white,
      brightBlack: bBlack,
      brightRed: bRed,
      brightGreen: bGreen,
      brightYellow: bYellow,
      brightBlue: bBlue,
      brightMagenta: bMagenta,
      brightCyan: bCyan,
      brightWhite: bWhite,
    },
  };
}

export const TERMINAL_THEMES: TerminalTheme[] = [
  theme(
    'davecode-dark',
    'DaveCode Dark',
    'dark',
    { background: '#000000', foreground: '#f4f4f5', cursor: '#ffffff', selection: '#3f3f46' },
    ['#18181b', '#f87171', '#4ade80', '#facc15', '#60a5fa', '#c084fc', '#22d3ee', '#d4d4d8'],
    ['#52525b', '#fca5a5', '#86efac', '#fde047', '#93c5fd', '#d8b4fe', '#67e8f9', '#ffffff'],
  ),
  theme(
    'github-dark',
    'GitHub Dark',
    'dark',
    { background: '#0d1117', foreground: '#e6edf3', cursor: '#2f81f7', selection: '#264f78' },
    ['#484f58', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4'],
    ['#6e7681', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#ffffff'],
  ),
  theme(
    'one-dark',
    'One Dark',
    'dark',
    { background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', selection: '#3e4451' },
    ['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf'],
    ['#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff'],
  ),
  theme(
    'dracula',
    'Dracula',
    'dark',
    { background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selection: '#44475a' },
    ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2'],
    ['#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff'],
  ),
  theme(
    'nord',
    'Nord',
    'dark',
    { background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', selection: '#434c5e' },
    ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0'],
    ['#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4'],
  ),
  theme(
    'tokyo-night',
    'Tokyo Night',
    'dark',
    { background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', selection: '#33467c' },
    ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6'],
    ['#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5'],
  ),
  theme(
    'catppuccin-mocha',
    'Catppuccin Mocha',
    'dark',
    { background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selection: '#45475a' },
    ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de'],
    ['#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8'],
  ),
  theme(
    'solarized-dark',
    'Solarized Dark',
    'dark',
    { background: '#002b36', foreground: '#839496', cursor: '#93a1a1', selection: '#073642' },
    ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5'],
    ['#586e75', '#cb4b16', '#93a1a1', '#839496', '#657b83', '#6c71c4', '#93a1a1', '#fdf6e3'],
  ),
  theme(
    'davecode-light',
    'DaveCode Light',
    'light',
    { background: '#ffffff', foreground: '#18181b', cursor: '#18181b', selection: '#d4d4d8' },
    ['#18181b', '#dc2626', '#16a34a', '#a16207', '#2563eb', '#9333ea', '#0891b2', '#71717a'],
    ['#52525b', '#ef4444', '#22c55e', '#ca8a04', '#3b82f6', '#a855f7', '#06b6d4', '#a1a1aa'],
  ),
  theme(
    'github-light',
    'GitHub Light',
    'light',
    { background: '#ffffff', foreground: '#1f2328', cursor: '#0969da', selection: '#b6e3ff' },
    ['#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781'],
    ['#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f'],
  ),
  theme(
    'one-light',
    'One Light',
    'light',
    { background: '#fafafa', foreground: '#383a42', cursor: '#526fff', selection: '#e5e5e6' },
    ['#383a42', '#e45649', '#50a14f', '#c18401', '#4078f2', '#a626a4', '#0184bc', '#a0a1a7'],
    ['#696c77', '#e45649', '#50a14f', '#c18401', '#4078f2', '#a626a4', '#0184bc', '#fafafa'],
  ),
  theme(
    'catppuccin-latte',
    'Catppuccin Latte',
    'light',
    { background: '#eff1f5', foreground: '#4c4f69', cursor: '#dc8a78', selection: '#ccd0da' },
    ['#5c5f77', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#acb0be'],
    ['#6c6f85', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#bcc0cc'],
  ),
  theme(
    'solarized-light',
    'Solarized Light',
    'light',
    { background: '#fdf6e3', foreground: '#657b83', cursor: '#586e75', selection: '#eee8d5' },
    ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5'],
    ['#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'],
  ),
];

export const TERMINAL_THEME_IDS: readonly string[] = TERMINAL_THEMES.map((t) => t.id);

export const DEFAULT_TERMINAL_THEMES = { dark: 'davecode-dark', light: 'davecode-light' } as const;

/** The theme with this id for this mode, or the mode's default when it is missing or the other mode's. */
export function terminalTheme(id: string, mode: 'dark' | 'light'): TerminalTheme {
  const found = TERMINAL_THEMES.find((t) => t.id === id && t.mode === mode);
  return (
    found ?? (TERMINAL_THEMES.find((t) => t.id === DEFAULT_TERMINAL_THEMES[mode]) as TerminalTheme)
  );
}
