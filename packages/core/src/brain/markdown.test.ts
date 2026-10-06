import { describe, expect, it } from 'vitest';
import { getSection, parseSections, touchLastUpdated, upsertSection } from './markdown';

const doc = `# Title

intro text

## Current focus

Working on A.

## Done

- one
- two

## Blockers

None.
`;

describe('parseSections / getSection', () => {
  it('lists level-2 sections only', () => {
    const md = '# T\n\n## A\n\n### sub\n\ntext\n\n## B\n';
    expect(parseSections(md).map((s) => s.heading)).toEqual(['A', 'B']);
  });

  it('ignores headings inside fenced code blocks', () => {
    const md = '## A\n\n```md\n## Not a heading\n```\n\n~~~\n## Nor this\n~~~\n\n## B\n\nbody\n';
    expect(parseSections(md).map((s) => s.heading)).toEqual(['A', 'B']);
    expect(getSection(md, 'A')).toContain('## Not a heading');
  });

  it('reads a section case-insensitively and trimmed', () => {
    expect(getSection(doc, 'done')).toBe('- one\n- two');
    expect(getSection(doc, 'Missing')).toBeUndefined();
  });
});

describe('upsertSection', () => {
  it('replaces one section and preserves everything else byte-for-byte', () => {
    const out = upsertSection(doc, 'Done', '- three');
    expect(out).toBe(doc.replace('- one\n- two', '- three'));
  });

  it('replaces the last section and keeps a single trailing newline', () => {
    const out = upsertSection(doc, 'Blockers', 'Waiting on review.');
    expect(out.endsWith('## Blockers\n\nWaiting on review.\n')).toBe(true);
    expect(out.startsWith(doc.slice(0, doc.indexOf('## Blockers')))).toBe(true);
  });

  it('appends a missing section after the existing content', () => {
    const out = upsertSection(doc, 'Notes', 'hello\nworld');
    expect(out).toBe(`${doc}\n## Notes\n\nhello\nworld\n`);
  });

  it('appends to an empty document', () => {
    expect(upsertSection('', 'A', 'x')).toBe('## A\n\nx\n');
  });

  it('is idempotent', () => {
    const once = upsertSection(doc, 'Done', '- three');
    expect(upsertSection(once, 'Done', '- three')).toBe(once);
  });

  it('does not touch ### subsections of other sections or text before the first heading', () => {
    const md = 'preamble\n\n## A\n\n### sub\n\nkeep\n\n## B\n\nold\n';
    const out = upsertSection(md, 'B', 'new');
    expect(out).toBe('preamble\n\n## A\n\n### sub\n\nkeep\n\n## B\n\nnew\n');
  });

  it('replacing a section replaces its ### subsections too', () => {
    const md = '## A\n\n### sub\n\nx\n\n## B\n\ny\n';
    expect(upsertSection(md, 'A', 'flat')).toBe('## A\n\nflat\n\n## B\n\ny\n');
  });

  it('preserves CRLF line endings', () => {
    const md = '## A\r\n\r\none\r\n\r\n## B\r\n\r\ntwo\r\n';
    expect(upsertSection(md, 'A', 'x\ny')).toBe('## A\r\n\r\nx\r\ny\r\n\r\n## B\r\n\r\ntwo\r\n');
    expect(upsertSection(md, 'B', 'z')).toBe('## A\r\n\r\none\r\n\r\n## B\r\n\r\nz\r\n');
    expect(upsertSection(md, 'C', 'w')).toBe(`${md}\r\n## C\r\n\r\nw\r\n`);
  });
});

describe('touchLastUpdated', () => {
  const date = new Date('2030-02-03T10:00:00Z');

  it('refreshes the line when present', () => {
    const md = '# T\n\n_Last updated: 2020-01-01_\n\n## A\n';
    expect(touchLastUpdated(md, date)).toBe('# T\n\n_Last updated: 2030-02-03_\n\n## A\n');
  });

  it('leaves documents without the line unchanged', () => {
    expect(touchLastUpdated(doc, date)).toBe(doc);
  });
});
