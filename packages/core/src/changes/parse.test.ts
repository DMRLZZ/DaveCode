import { describe, expect, it } from 'vitest';
import {
  countLines,
  mergeFileLists,
  newFilePatch,
  parseNameStatus,
  parseNumStat,
  scrubUrls,
  slugify,
} from './parse';
import { fallbackSuggestion, parseAgentSuggestion } from './suggest';

describe('parseNameStatus', () => {
  it('reads plain changes and renames', () => {
    const out = 'M\0src/a.ts\0A\0src/new.ts\0D\0old.md\0R087\0src/b.ts\0src/c.ts\0T\0link\0';
    expect(parseNameStatus(out)).toEqual([
      { path: 'src/a.ts', status: 'modified' },
      { path: 'src/new.ts', status: 'added' },
      { path: 'old.md', status: 'deleted' },
      { path: 'src/c.ts', oldPath: 'src/b.ts', status: 'renamed' },
      { path: 'link', status: 'modified' },
    ]);
  });

  it('keeps paths with spaces and tabs intact', () => {
    expect(parseNameStatus('M\0a dir/x\ty.ts\0')).toEqual([
      { path: 'a dir/x\ty.ts', status: 'modified' },
    ]);
  });

  it('is empty for no output', () => {
    expect(parseNameStatus('')).toEqual([]);
  });
});

describe('parseNumStat', () => {
  it('reads counts, renames and binaries', () => {
    const stats = parseNumStat(
      '3\t1\tsrc/a.ts\0' + '2\t0\t\0src/b.ts\0src/c.ts\0' + '-\t-\timg.png\0',
    );
    expect(stats.get('src/a.ts')).toEqual({ additions: 3, deletions: 1, binary: false });
    expect(stats.get('src/c.ts')).toEqual({ additions: 2, deletions: 0, binary: false });
    expect(stats.get('img.png')).toEqual({ additions: 0, deletions: 0, binary: true });
    expect(stats.has('src/b.ts')).toBe(false);
  });
});

describe('mergeFileLists', () => {
  it('joins counts to files, adds untracked ones and sorts by path', () => {
    const files = mergeFileLists(
      [{ path: 'z.ts', status: 'modified' }],
      new Map([['z.ts', { additions: 1, deletions: 2, binary: false }]]),
      [{ path: 'a.ts', status: 'untracked', additions: 4, deletions: 0, binary: false }],
    );
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['a.ts', 'untracked', 4, 0],
      ['z.ts', 'modified', 1, 2],
    ]);
  });
});

describe('newFilePatch', () => {
  it('renders a text file as an all-added hunk', () => {
    expect(newFilePatch('n.txt', Buffer.from('one\ntwo\n'))).toBe(
      'diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n',
    );
  });

  it('marks a missing final newline like git', () => {
    expect(newFilePatch('n.txt', Buffer.from('one'))).toContain(
      '+one\n\\ No newline at end of file\n',
    );
  });

  it('marks binary and unreadable files', () => {
    expect(newFilePatch('b.bin', Buffer.from([1, 0, 2]))).toContain(
      'Binary files /dev/null and b/b.bin differ',
    );
    expect(newFilePatch('big.txt', undefined)).toContain('Binary files');
  });
});

describe('helpers', () => {
  it('counts lines with and without a final newline', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb')).toBe(2);
  });

  it('slugifies titles into branch fragments', () => {
    expect(slugify('feat(ui): Añadir el panel de Cambios!')).toBe('anadir-el-panel-de-cambios');
    expect(slugify('???')).toBe('changes');
    expect(slugify('a'.repeat(80)).length).toBe(40);
  });

  it('removes credentials from URLs', () => {
    expect(scrubUrls('fatal: https://x-access-token:ghs_abc@github.com/o/r.git')).toBe(
      'fatal: https://***@github.com/o/r.git',
    );
  });
});

describe('fallbackSuggestion', () => {
  const file = (path: string, status: 'modified' | 'untracked' = 'modified') => ({
    path,
    status,
    additions: 1,
    deletions: 0,
    binary: false,
  });

  it('names a single file', () => {
    expect(fallbackSuggestion([file('src/new.ts', 'untracked')]).message).toBe('chore: add new.ts');
  });

  it('uses docs and test types and a shared package scope', () => {
    expect(fallbackSuggestion([file('README.md'), file('docs/API.md')]).message).toBe(
      'docs: update 2 files',
    );
    expect(
      fallbackSuggestion([file('packages/ui/src/a.test.ts'), file('packages/ui/src/b.test.ts')])
        .message,
    ).toBe('test(ui): update 2 files');
  });

  it('lists the files in the body', () => {
    const body = fallbackSuggestion([file('a.ts'), file('b.ts')]).body;
    expect(body).toContain('- `a.ts` — +1 −0');
    expect(body).toContain('- `b.ts`');
  });
});

describe('parseAgentSuggestion', () => {
  it('finds the JSON object inside chatter and code fences', () => {
    const reply = 'Sure!\n```json\n{"message":"feat: add x","title":"Add x","body":"- x"}\n```';
    expect(parseAgentSuggestion(reply)).toEqual({
      message: 'feat: add x',
      title: 'Add x',
      body: '- x',
    });
  });

  it('rejects replies without the fields', () => {
    expect(parseAgentSuggestion('{"message":""}')).toBeUndefined();
    expect(parseAgentSuggestion('no json here')).toBeUndefined();
  });
});
