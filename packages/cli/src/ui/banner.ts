import { brandLogo } from '@davecode/core';
import type { Theme } from './theme';

/**
 * The bird with a few lines of text beside it, vertically centred. Terminals narrower than
 * `minColumns` get the text alone.
 */
export function brandBanner(theme: Theme, text: string[], columns = 80, minColumns = 56): string[] {
  if (columns < minColumns) return text;
  const art = brandLogo(theme.unicode);
  const width = Math.max(...art.map((line) => line.length)) + 4;
  const start = Math.max(0, Math.floor((art.length - text.length) / 2));
  return art.map((line, i) => {
    const beside = text[i - start];
    return beside ? `${theme.accent(line.padEnd(width))}${beside}` : theme.accent(line);
  });
}
