/**
 * Deterministic quality gates: runs `runner.validate.lint`, `typecheck` and `test` (each
 * optional) in the repository and produces a {@link ValidationReport} whose `summary` is
 * written for both humans and the repairing model (exact stdout/stderr tails included).
 */
import { CommandError, projectEnv, runProcess, splitCommand } from './process';

export const VALIDATION_STEPS = ['lint', 'typecheck', 'test'] as const;
export type ValidationStepName = (typeof VALIDATION_STEPS)[number];

export type ValidationCommands = Partial<Record<ValidationStepName, string | undefined>>;

export interface ValidationStep {
  name: ValidationStepName;
  command: string;
  ok: boolean;
  exitCode: number | null;
  /** Tail of stdout (the end is kept because that is where errors are). */
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ValidationReport {
  ok: boolean;
  steps: ValidationStep[];
  durationMs: number;
  /** Plain-text report: one status line per step, then the output of failing steps. */
  summary: string;
}

export interface ValidatorOptions {
  root: string;
  commands: ValidationCommands;
  /** Per-command timeout (default 10 min). */
  timeoutMs?: number;
  /** Characters of stdout and of stderr kept per step (default 12 000 each). */
  maxOutputChars?: number;
  env?: NodeJS.ProcessEnv;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function statusLine(step: ValidationStep): string {
  if (step.ok) return `- ${step.name}: PASS (${seconds(step.durationMs)}) \`${step.command}\``;
  const why = step.timedOut ? 'timed out' : `exit ${step.exitCode ?? 'none'}`;
  return `- ${step.name}: FAIL, ${why} (${seconds(step.durationMs)}) \`${step.command}\``;
}

/** Renders the human/LLM-readable report for a set of steps. */
export function summarizeValidation(steps: ValidationStep[]): string {
  if (steps.length === 0) return 'Validation PASSED: no validation commands are configured.';
  const failed = steps.filter((s) => !s.ok);
  const lines = [
    failed.length === 0
      ? 'Validation PASSED.'
      : `Validation FAILED (${failed.map((s) => s.name).join(', ')}).`,
    ...steps.map(statusLine),
  ];
  for (const step of failed) {
    lines.push('', `### ${step.name} output (\`${step.command}\`)`);
    if (step.stdout.trim()) lines.push('stdout:', '```', step.stdout.trimEnd(), '```');
    if (step.stderr.trim()) lines.push('stderr:', '```', step.stderr.trimEnd(), '```');
    if (!step.stdout.trim() && !step.stderr.trim()) lines.push('(no output)');
  }
  return lines.join('\n');
}

export class Validator {
  constructor(private readonly options: ValidatorOptions) {}

  /** Configured steps in run order. */
  get configured(): Array<{ name: ValidationStepName; command: string }> {
    return VALIDATION_STEPS.flatMap((name) => {
      const command = this.options.commands[name]?.trim();
      return command ? [{ name, command }] : [];
    });
  }

  /** Runs every configured step (all of them, so the report shows every failure). */
  async validate(signal?: AbortSignal): Promise<ValidationReport> {
    const started = Date.now();
    const steps: ValidationStep[] = [];
    for (const { name, command } of this.configured) {
      if (signal?.aborted) break;
      steps.push(await this.runStep(name, command, signal));
    }
    return {
      ok: steps.every((s) => s.ok),
      steps,
      durationMs: Date.now() - started,
      summary: summarizeValidation(steps),
    };
  }

  private async runStep(
    name: ValidationStepName,
    command: string,
    signal?: AbortSignal,
  ): Promise<ValidationStep> {
    let argv: string[];
    try {
      argv = splitCommand(command);
    } catch (err) {
      return this.failed(name, command, err instanceof CommandError ? err.message : String(err));
    }
    const [file, ...args] = argv;
    if (!file) return this.failed(name, command, 'empty command');
    const result = await runProcess({
      command: file,
      args,
      cwd: this.options.root,
      timeoutMs: this.options.timeoutMs ?? 600_000,
      env: projectEnv(this.options.root, this.options.env ?? process.env),
      maxOutputChars: this.options.maxOutputChars ?? 12_000,
      ...(signal ? { signal } : {}),
    });
    return {
      name,
      command,
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
    };
  }

  private failed(name: ValidationStepName, command: string, stderr: string): ValidationStep {
    return {
      name,
      command,
      ok: false,
      exitCode: null,
      stdout: '',
      stderr,
      durationMs: 0,
      timedOut: false,
    };
  }
}
