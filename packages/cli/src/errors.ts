/** A user-facing failure: printed as `error: <message>` plus an optional hint, never a stack. */
export class CliError extends Error {
  readonly exitCode: number;
  readonly hint: string | undefined;

  constructor(
    message: string,
    options: { exitCode?: number; hint?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CliError';
    this.exitCode = options.exitCode ?? 1;
    this.hint = options.hint;
  }
}

/** Exit codes used across commands. */
export const EXIT = {
  ok: 0,
  failure: 1,
  /** The feature exists in the CLI but its engine part has not landed yet. */
  unavailable: 2,
} as const;
