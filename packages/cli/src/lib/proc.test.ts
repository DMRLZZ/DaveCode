import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TempDir, tempDir } from '../test-utils';
import { splitPathEnv, which } from './proc';

describe('splitPathEnv', () => {
  it('keeps Windows drive letters when the delimiter is :', () => {
    expect(splitPathEnv('C:\\tmp\\bin;D:\\other', ';')).toEqual(['C:\\tmp\\bin', 'D:\\other']);
    expect(splitPathEnv('C:\\tmp\\bin:D:\\other:/usr/bin', ':')).toEqual([
      'C:\\tmp\\bin',
      'D:\\other',
      '/usr/bin',
    ]);
  });
});

describe('which', () => {
  let tmp: TempDir;
  beforeEach(() => {
    tmp = tempDir();
  });
  afterEach(() => tmp.cleanup());

  it('finds a bare binary under a Windows PATH when platform is linux', () => {
    const bin = join(tmp.path, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'xterm'), '');
    expect(which('xterm', { PATH: bin }, 'linux')).toBe(join(bin, 'xterm'));
  });
});
