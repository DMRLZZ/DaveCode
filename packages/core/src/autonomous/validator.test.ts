import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { summarizeValidation, Validator } from './validator';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'davecode-validate-'));
  writeFileSync(join(root, 'ok.cjs'), 'console.log("all good");');
  writeFileSync(
    join(root, 'fail.cjs'),
    'console.log("x".repeat(20000)); console.error("TypeError: boom at line 3"); process.exit(2);',
  );
  writeFileSync(join(root, 'slow.cjs'), 'setTimeout(() => {}, 60000);');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('Validator', () => {
  it('passes with no commands configured', async () => {
    const report = await new Validator({ root, commands: {} }).validate();
    expect(report.ok).toBe(true);
    expect(report.steps).toEqual([]);
    expect(report.summary).toMatch(/no validation commands/);
  });

  it('runs lint, typecheck and test in order and reports every failure', async () => {
    const validator = new Validator({
      root,
      commands: { test: 'node fail.cjs', lint: 'node ok.cjs', typecheck: 'node "ok.cjs"' },
      maxOutputChars: 500,
    });
    expect(validator.configured.map((s) => s.name)).toEqual(['lint', 'typecheck', 'test']);
    const report = await validator.validate();
    expect(report.ok).toBe(false);
    expect(report.steps.map((s) => [s.name, s.ok])).toEqual([
      ['lint', true],
      ['typecheck', true],
      ['test', false],
    ]);
    const test = report.steps[2]!;
    expect(test.exitCode).toBe(2);
    expect(test.stderr).toContain('TypeError: boom at line 3');
    // stdout is truncated tail-first.
    expect(test.stdout.length).toBeLessThan(700);
    expect(test.stdout).toContain('earlier characters truncated');
    expect(report.summary).toContain('Validation FAILED (test)');
    expect(report.summary).toContain('- lint: PASS');
    expect(report.summary).toContain('- test: FAIL, exit 2');
    expect(report.summary).toContain('TypeError: boom at line 3');
  });

  it('times out slow commands and rejects malformed ones', async () => {
    const report = await new Validator({
      root,
      commands: { test: 'node slow.cjs', lint: 'node "unterminated' },
      timeoutMs: 1_000,
    }).validate();
    expect(report.steps[0]).toMatchObject({ name: 'lint', ok: false });
    expect(report.steps[0]?.stderr).toMatch(/Unterminated/);
    expect(report.steps[1]).toMatchObject({ name: 'test', ok: false, timedOut: true });
    expect(report.summary).toContain('timed out');
  });

  it('stops between steps when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const report = await new Validator({ root, commands: { test: 'node ok.cjs' } }).validate(
      controller.signal,
    );
    expect(report.steps).toEqual([]);
  });

  it('renders a pass summary', () => {
    expect(
      summarizeValidation([
        {
          name: 'test',
          command: 'x',
          ok: true,
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: 1500,
          timedOut: false,
        },
      ]),
    ).toBe('Validation PASSED.\n- test: PASS (1.5s) `x`');
  });
});
