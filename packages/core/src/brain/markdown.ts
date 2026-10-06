/**
 * A deliberately small markdown section parser. It only understands level-2 headings
 * (`## Title`) outside fenced code blocks, which is all STATE.md needs. Everything else is
 * treated as opaque text and preserved byte-for-byte.
 */

export interface MarkdownSection {
  heading: string;
  /** Index of the `## ` line. */
  start: number;
  /** Exclusive end index (start of the next section, or number of lines). */
  end: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const H2 = /^##[ \t]+(\S.*?)[ \t]*$/;

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function listSections(lines: string[]): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let fence: string | undefined;
  lines.forEach((raw, index) => {
    const line = stripCr(raw);
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = (fenceMatch[1] as string)[0] as string;
      if (fence === undefined) fence = marker;
      else if (fence === marker) fence = undefined;
      return;
    }
    if (fence !== undefined) return;
    const match = H2.exec(line);
    if (match) {
      const prev = sections[sections.length - 1];
      if (prev) prev.end = index;
      sections.push({
        heading: (match[1] as string).replace(/\s+#+$/, ''),
        start: index,
        end: lines.length,
      });
    }
  });
  return sections;
}

const sameHeading = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Level-2 sections in document order. */
export function parseSections(markdown: string): MarkdownSection[] {
  return listSections(markdown.split('\n'));
}

/** Body text of a `## heading` section (without the heading line), trimmed; undefined if absent. */
export function getSection(markdown: string, heading: string): string | undefined {
  const lines = markdown.split('\n');
  const section = listSections(lines).find((s) => sameHeading(s.heading, heading));
  if (!section) return undefined;
  return lines
    .slice(section.start + 1, section.end)
    .map(stripCr)
    .join('\n')
    .trim();
}

/**
 * Replaces the body of `## heading` (matched case-insensitively), or appends a new section at the
 * end when it does not exist. All other content is left untouched.
 */
export function upsertSection(markdown: string, heading: string, body: string): string {
  const crlf = markdown.includes('\r\n');
  const cr = crlf ? '\r' : '';
  const block = [`## ${heading.trim()}`, '', ...body.trim().split(/\r?\n/)].map((l) => l + cr);

  const lines = markdown.split('\n');
  const section = listSections(lines).find((s) => sameHeading(s.heading, heading));

  if (!section) {
    const base = markdown.replace(/\s+$/, '');
    if (base === '') return `${block.join('\n')}\n`;
    return `${base}${crlf ? '\r\n\r\n' : '\n\n'}${block.join('\n')}\n`;
  }

  const after = lines.slice(section.end);
  // A following section needs a blank separator line; the last section just ends with a newline.
  const replacement = after.length > 0 ? [...block, cr] : [...block, ''];
  return [...lines.slice(0, section.start), ...replacement, ...after].join('\n');
}

const LAST_UPDATED = /^_Last updated: \d{4}-\d{2}-\d{2}_[ \t]*(\r?)$/m;

/** Rewrites the `_Last updated: YYYY-MM-DD_` line when present; otherwise returns the input. */
export function touchLastUpdated(markdown: string, date: Date): string {
  const day = date.toISOString().slice(0, 10);
  return markdown.replace(LAST_UPDATED, (_m, cr: string) => `_Last updated: ${day}_${cr}`);
}
