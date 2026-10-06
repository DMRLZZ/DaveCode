import type { Theme } from './theme';

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences
const ANSI = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** Visible width (ANSI-stripped). Good enough for the ASCII/BMP text the CLI prints. */
export function visibleWidth(text: string): number {
  return [...stripAnsi(text)].length;
}

export function padEnd(text: string, width: number): string {
  const gap = width - visibleWidth(text);
  return gap > 0 ? text + ' '.repeat(gap) : text;
}

export function padStart(text: string, width: number): string {
  const gap = width - visibleWidth(text);
  return gap > 0 ? ' '.repeat(gap) + text : text;
}

/** Cut plain text to `width` columns, ending with an ellipsis when shortened. */
export function truncate(text: string, width: number, ellipsis = '…'): string {
  const chars = [...text];
  if (chars.length <= width) return text;
  if (width <= ellipsis.length) return chars.slice(0, Math.max(0, width)).join('');
  return chars.slice(0, width - ellipsis.length).join('') + ellipsis;
}

/** 0.234 → "23%". Values above 1 are shown as-is (an over-quota account reads "104%"). */
export function percent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%';
  return `${Math.round(ratio * 100)}%`;
}

/** 950 → "950", 12_300 → "12.3k", 4_500_000 → "4.5M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000) return `${trimZero((n / 1000).toFixed(1))}k`;
  return `${trimZero((n / 1_000_000).toFixed(1))}M`;
}

function trimZero(text: string): string {
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}

/** 42 → "42s", 3_725 → "1h 2m", 90_061 → "1d 1h". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Colour for a utilization ratio: calm below 70%, warning to 90%, error above. */
export function levelStyle(theme: Theme, ratio: number): (text: string) => string {
  if (ratio >= 0.9) return theme.error;
  if (ratio >= 0.7) return theme.warn;
  return theme.ok;
}

/**
 * A fixed-width quota bar, e.g. `████░░░░`. `ratio` is clamped to 0..1 for drawing.
 * Unlimited windows (`limited: false`) draw a dim empty track.
 */
export function bar(theme: Theme, ratio: number, width = 10, limited = true): string {
  const w = Math.max(1, width);
  if (!limited) return theme.dim(theme.glyph.barEmpty.repeat(w));
  const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
  let filled = Math.round(clamped * w);
  if (clamped > 0 && filled === 0) filled = 1;
  const style = levelStyle(theme, ratio);
  return (
    style(theme.glyph.barFull.repeat(filled)) + theme.dim(theme.glyph.barEmpty.repeat(w - filled))
  );
}

export interface Column {
  header: string;
  align?: 'left' | 'right';
  /** Columns with a higher number are dropped first when the terminal is narrow. */
  drop?: number;
}

/**
 * Render rows as aligned columns separated by two spaces. Columns are dropped in `drop`
 * order (highest first) until the table fits in `maxWidth`.
 */
export function table(
  theme: Theme,
  columns: Column[],
  rows: string[][],
  maxWidth = Number.POSITIVE_INFINITY,
): string[] {
  let visible = columns.map((_, i) => i);
  const widthOf = (indexes: number[]) => {
    const widths = indexes.map((i) =>
      Math.max(visibleWidth(columns[i]!.header), ...rows.map((r) => visibleWidth(r[i] ?? ''))),
    );
    return { widths, total: widths.reduce((a, b) => a + b, 0) + 2 * (indexes.length - 1) };
  };
  let layout = widthOf(visible);
  while (layout.total > maxWidth) {
    const droppable = visible
      .filter((i) => (columns[i]!.drop ?? 0) > 0)
      .sort((a, b) => (columns[b]!.drop ?? 0) - (columns[a]!.drop ?? 0));
    const victim = droppable[0];
    if (victim === undefined) break;
    visible = visible.filter((i) => i !== victim);
    layout = widthOf(visible);
  }
  const render = (cells: string[], style?: (s: string) => string) =>
    visible
      .map((col, k) => {
        const width = layout.widths[k]!;
        const cell = cells[col] ?? '';
        const text = style ? style(cell) : cell;
        const last = k === visible.length - 1;
        if (columns[col]!.align === 'right') return padStart(text, width);
        return last ? text : padEnd(text, width);
      })
      .join('  ')
      .trimEnd();
  return [
    render(
      columns.map((c) => c.header),
      theme.dim,
    ),
    ...rows.map((r) => render(r)),
  ];
}

/** Section heading: accent title with an optional dim suffix. */
export function heading(theme: Theme, title: string, suffix?: string): string {
  return suffix
    ? `${theme.bold(theme.accent(title))}  ${theme.dim(suffix)}`
    : theme.bold(theme.accent(title));
}
