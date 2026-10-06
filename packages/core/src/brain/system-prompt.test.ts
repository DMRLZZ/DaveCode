import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DAVECODE_SYSTEM_PROMPT } from './system-prompt';

describe('DAVECODE_SYSTEM_PROMPT', () => {
  it('matches the fenced block in docs/SPEC.md section 6', () => {
    const spec = readFileSync(
      fileURLToPath(new URL('../../../../docs/SPEC.md', import.meta.url)),
      'utf8',
    ).replace(/\r\n/g, '\n');
    const section = spec.slice(spec.indexOf('## 6. Master Prompt'));
    const match = /```text\n([\s\S]*?)\n```/.exec(section);
    expect(match).not.toBeNull();
    expect(DAVECODE_SYSTEM_PROMPT).toBe(match?.[1]);
  });

  it('mentions the brain files and task states', () => {
    for (const needle of ['STATE.md', 'TASK_GRAPH.json', 'PENDING', 'IN_PROGRESS', 'SUCCESS']) {
      expect(DAVECODE_SYSTEM_PROMPT).toContain(needle);
    }
  });
});
