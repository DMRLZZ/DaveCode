/**
 * Brand assets shared by the CLI, the sign-in pages and the apps. Change the logo here and
 * everything that draws it follows.
 */

/** Monochrome mark (inherits `currentColor`). */
export const BRAND_MARK_SVG =
  '<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<rect x="1.5" y="1.5" width="37" height="37" rx="9" stroke="currentColor" stroke-width="3"/>' +
  '<path d="M12 14l6 6-6 6" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M21 27h8" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';

/** 5-row block glyphs for the terminal wordmark. */
const GLYPHS: Record<string, string[]> = {
  D: ['████ ', '█   █', '█   █', '█   █', '████ '],
  A: [' ███ ', '█   █', '█████', '█   █', '█   █'],
  V: ['█   █', '█   █', '█   █', ' █ █ ', '  █  '],
  E: ['█████', '█    ', '████ ', '█    ', '█████'],
  C: [' ████', '█    ', '█    ', '█    ', ' ████'],
  O: [' ███ ', '█   █', '█   █', '█   █', ' ███ '],
};

/**
 * The wordmark as terminal lines. `unicode: false` swaps the block for `#` on terminals that
 * cannot draw it.
 */
export function brandWordmark(unicode = true): string[] {
  const word = 'DAVECODE';
  return [0, 1, 2, 3, 4].map((row) => {
    const line = [...word].map((letter) => GLYPHS[letter]?.[row] ?? '').join(' ');
    return unicode ? line : line.replaceAll('█', '#');
  });
}
