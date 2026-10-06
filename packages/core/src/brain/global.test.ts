import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GlobalBrain, InvalidNoteNameError, sanitizeNoteName } from './global';

let home: string;
let brain: GlobalBrain;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'davecode-global-'));
  brain = new GlobalBrain(join(home, 'brain'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('sanitizeNoteName', () => {
  it('accepts plain names and strips .md', () => {
    expect(sanitizeNoteName('typescript-style')).toBe('typescript-style');
    expect(sanitizeNoteName('Prefs_1.md')).toBe('Prefs_1');
    expect(sanitizeNoteName('  my notes  ')).toBe('my notes');
  });

  it.each([
    '',
    '   ',
    '../secrets',
    '..',
    'a/b',
    'a\\b',
    '/etc/passwd',
    'C:\\Windows\\x',
    '.hidden',
    'a..b',
    'trailing.',
    'bad\u0000name',
    'bad:name',
    'CON',
    'nul.txt',
    'x'.repeat(101),
  ])('rejects %j', (name) => {
    expect(() => sanitizeNoteName(name)).toThrow(InvalidNoteNameError);
  });
});

describe('GlobalBrain', () => {
  it('lists nothing when the directory does not exist', async () => {
    expect(await brain.list()).toEqual([]);
    expect(await brain.compose()).toBe('');
    expect(await brain.read('nope')).toBeUndefined();
  });

  it('writes, reads, lists and deletes notes', async () => {
    await brain.write('style', '# Style\n\nUse tabs.\n');
    await brain.write('patterns.md', 'Prefer composition.');
    expect(await brain.read('style')).toBe('# Style\n\nUse tabs.\n');
    expect(await brain.read('style.md')).toBe('# Style\n\nUse tabs.\n');

    const listed = await brain.list();
    expect(listed.map((n) => n.name)).toEqual(['patterns', 'style']);
    expect(listed[1]?.bytes).toBe(Buffer.byteLength('# Style\n\nUse tabs.\n'));
    expect(Number.isNaN(Date.parse(listed[0]?.updatedAt ?? ''))).toBe(false);

    expect(await brain.delete('style')).toBe(true);
    expect(await brain.delete('style')).toBe(false);
    expect((await brain.list()).map((n) => n.name)).toEqual(['patterns']);
  });

  it('overwrites without leaving temp files', async () => {
    await brain.write('a', 'one');
    await brain.write('a', 'two');
    expect(await brain.read('a')).toBe('two');
    expect(await readdir(brain.dir)).toEqual(['a.md']);
  });

  it('ignores non-markdown and oddly named files when listing', async () => {
    await mkdir(brain.dir, { recursive: true });
    await writeFile(join(brain.dir, 'ok.md'), 'x');
    await writeFile(join(brain.dir, 'readme.txt'), 'x');
    await writeFile(join(brain.dir, '.hidden.md'), 'x');
    expect((await brain.list()).map((n) => n.name)).toEqual(['ok']);
  });

  it('rejects path traversal on every operation and never writes outside the brain', async () => {
    await expect(brain.write('../escape', 'x')).rejects.toThrow(InvalidNoteNameError);
    await expect(brain.read('../../etc/passwd')).rejects.toThrow(InvalidNoteNameError);
    await expect(brain.delete('..\\escape')).rejects.toThrow(InvalidNoteNameError);
    expect(await readdir(home)).not.toContain('escape.md');
  });

  it('compose concatenates notes sorted by name with headings, skipping empty ones', async () => {
    await brain.write('zeta', 'Last.\n');
    await brain.write('alpha', '\nFirst.\n\n');
    await brain.write('empty', '   \n');
    expect(await brain.compose()).toBe('## alpha\n\nFirst.\n\n## zeta\n\nLast.');
  });
});
