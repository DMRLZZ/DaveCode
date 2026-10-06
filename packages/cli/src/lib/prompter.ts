/**
 * Interactive questions, decoupled from how they are drawn. Production uses the Ink prompts in
 * `tui/prompts.tsx`; tests script the answers.
 */

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export interface TextOptions {
  initial?: string;
  placeholder?: string;
  /** Return an error message to reject the value. */
  validate?: (value: string) => string | undefined;
}

export interface SecretOptions {
  /** Allow an empty answer (e.g. an optional API key). */
  optional?: boolean;
}

export interface Prompter {
  select<T extends string>(message: string, choices: Choice<T>[], initial?: T): Promise<T>;
  text(message: string, options?: TextOptions): Promise<string>;
  /** Masked input; the value is never echoed. */
  secret(message: string, options?: SecretOptions): Promise<string>;
  confirm(message: string, initial?: boolean): Promise<boolean>;
}

/** Thrown when the user aborts a prompt (Esc / Ctrl+C). */
export class PromptCancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'PromptCancelledError';
  }
}

/** A prompter that replays queued answers in order (tests and scripted flows). */
export function scriptedPrompter(answers: Array<string | boolean>): Prompter & {
  asked: string[];
} {
  const queue = [...answers];
  const asked: string[] = [];
  const next = (message: string) => {
    asked.push(message);
    if (queue.length === 0) throw new Error(`No scripted answer for: ${message}`);
    return queue.shift()!;
  };
  return {
    asked,
    async select<T extends string>(message: string, choices: Choice<T>[]) {
      const answer = String(next(message));
      const choice = choices.find((c) => c.value === answer);
      if (!choice) throw new Error(`Scripted answer ${answer} is not a choice for: ${message}`);
      return choice.value;
    },
    async text(message: string, options: TextOptions = {}) {
      const answer = String(next(message));
      const value = answer === '' ? (options.initial ?? '') : answer;
      const problem = options.validate?.(value);
      if (problem) throw new Error(`Scripted answer rejected for ${message}: ${problem}`);
      return value;
    },
    async secret(message: string) {
      return String(next(message));
    },
    async confirm(message: string) {
      return Boolean(next(message));
    },
  };
}
