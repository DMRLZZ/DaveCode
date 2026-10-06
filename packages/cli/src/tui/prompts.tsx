import { Box, render, Text, useInput } from 'ink';
import { type ReactElement, useState } from 'react';
import type { InStream, OutStream } from '../context';
import {
  type Choice,
  PromptCancelledError,
  type Prompter,
  type SecretOptions,
  type TextOptions,
} from '../lib/prompter';
import type { Theme } from '../ui/theme';
import { ThemeProvider, useTheme } from './theme-context';

/** Drop line breaks and control characters from typed or pasted single-line input. */
export function sanitizeLine(input: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters
  return input.replace(/[\u0000-\u001f\u007f]/g, '');
}

interface Settle<T> {
  done: (value: T) => void;
  cancel: () => void;
}

function Question({ message, answer }: { message: string; answer?: string }) {
  const theme = useTheme();
  return (
    <Text>
      <Text color={answer === undefined ? theme.ink.accent : theme.ink.ok}>
        {answer === undefined ? '?' : theme.glyph.ok}
      </Text>{' '}
      <Text bold>{message}</Text>
      {answer !== undefined ? <Text dimColor={theme.ink.dim}> {answer}</Text> : null}
    </Text>
  );
}

export function SelectPrompt<T extends string>({
  message,
  choices,
  initial,
  done,
  cancel,
}: { message: string; choices: Choice<T>[]; initial?: T } & Settle<T>) {
  const theme = useTheme();
  const start = Math.max(
    0,
    choices.findIndex((c) => c.value === initial),
  );
  const [index, setIndex] = useState(start);
  const [chosen, setChosen] = useState<Choice<T> | undefined>();

  useInput((input, key) => {
    if (chosen) return;
    if (key.escape || (key.ctrl && input === 'c')) return cancel();
    if (key.upArrow || input === 'k') setIndex((i) => (i - 1 + choices.length) % choices.length);
    else if (key.downArrow || input === 'j') setIndex((i) => (i + 1) % choices.length);
    else if (key.return) {
      const choice = choices[index]!;
      setChosen(choice);
      done(choice.value);
    } else if (/^[1-9]$/.test(input) && Number(input) <= choices.length) {
      setIndex(Number(input) - 1);
    }
  });

  if (chosen) return <Question message={message} answer={chosen.label} />;
  return (
    <Box flexDirection="column">
      <Question message={message} />
      {choices.map((choice, i) => {
        const active = i === index;
        return (
          <Text key={choice.value}>
            <Text color={active ? theme.ink.accent : undefined}>
              {active ? ` ${theme.glyph.prompt} ` : '   '}
              {choice.label}
            </Text>
            {choice.hint ? <Text dimColor={theme.ink.dim}> {choice.hint}</Text> : null}
          </Text>
        );
      })}
      <Text dimColor={theme.ink.dim}> ↑/↓ to move, Enter to select, Esc to cancel</Text>
    </Box>
  );
}

export function TextPrompt({
  message,
  initial = '',
  placeholder,
  validate,
  mask,
  optional,
  done,
  cancel,
}: TextOptions & SecretOptions & { message: string; mask?: boolean } & Settle<string>) {
  const theme = useTheme();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | undefined>();
  const [submitted, setSubmitted] = useState(false);

  useInput((input, key) => {
    if (submitted) return;
    if (key.escape || (key.ctrl && input === 'c')) return cancel();
    if (key.return) {
      if (mask && !optional && value.trim() === '') {
        setError('a value is required');
        return;
      }
      const problem = validate?.(value);
      if (problem) {
        setError(problem);
        return;
      }
      setSubmitted(true);
      done(value);
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => [...v].slice(0, -1).join(''));
    } else if (key.ctrl && input === 'u') {
      setValue('');
    } else if (!key.ctrl && !key.meta) {
      const text = sanitizeLine(input);
      if (text) setValue((v) => v + text);
    }
    setError(undefined);
  });

  const shown = mask ? '•'.repeat(Math.min([...value].length, 32)) : value;
  if (submitted) {
    const answer = mask ? (value ? 'set' : 'skipped') : value || '(empty)';
    return <Question message={message} answer={answer} />;
  }
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={theme.ink.accent}>?</Text> <Text bold>{message}</Text>{' '}
        {shown ? <Text>{shown}</Text> : <Text dimColor={theme.ink.dim}>{placeholder ?? ''}</Text>}
        <Text inverse> </Text>
      </Text>
      {error ? (
        <Text color={theme.ink.error}>
          {'  '}
          {error}
        </Text>
      ) : null}
    </Box>
  );
}

export function ConfirmPrompt({
  message,
  initial,
  done,
  cancel,
}: { message: string; initial: boolean } & Settle<boolean>) {
  const theme = useTheme();
  const [answer, setAnswer] = useState<boolean | undefined>();
  useInput((input, key) => {
    if (answer !== undefined) return;
    if (key.escape || (key.ctrl && input === 'c')) return cancel();
    let value: boolean | undefined;
    if (key.return) value = initial;
    else if (/^y$/i.test(input)) value = true;
    else if (/^n$/i.test(input)) value = false;
    if (value === undefined) return;
    setAnswer(value);
    done(value);
  });
  if (answer !== undefined) return <Question message={message} answer={answer ? 'yes' : 'no'} />;
  return (
    <Text>
      <Text color={theme.ink.accent}>?</Text> <Text bold>{message}</Text>{' '}
      <Text dimColor={theme.ink.dim}>{initial ? '(Y/n)' : '(y/N)'}</Text>
    </Text>
  );
}

export interface InkPrompterOptions {
  stdout: OutStream;
  stdin: InStream;
  theme: Theme;
}

/** Ink-backed prompter: each question is a short-lived Ink app that leaves its answer behind. */
export function createInkPrompter(options: InkPrompterOptions): Prompter {
  const ask = <T,>(element: (settle: Settle<T>) => ReactElement): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let result: { ok: true; value: T } | { ok: false } | undefined;
      const instance = render(
        <ThemeProvider theme={options.theme}>
          {element({
            done: (value) => {
              result = { ok: true, value };
              setImmediate(() => instance.unmount());
            },
            cancel: () => {
              result = { ok: false };
              setImmediate(() => instance.unmount());
            },
          })}
        </ThemeProvider>,
        {
          stdout: options.stdout as NodeJS.WriteStream,
          stdin: options.stdin as NodeJS.ReadStream,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      instance.waitUntilExit().then(
        () => {
          if (result?.ok) resolve(result.value);
          else reject(new PromptCancelledError());
        },
        (err: unknown) => reject(err),
      );
    });

  return {
    select: (message, choices, initial) =>
      ask((s) => (
        <SelectPrompt
          message={message}
          choices={choices}
          {...(initial !== undefined ? { initial } : {})}
          {...s}
        />
      )),
    text: (message, opts = {}) => ask((s) => <TextPrompt message={message} {...opts} {...s} />),
    secret: (message, opts = {}) =>
      ask((s) => <TextPrompt message={message} mask {...opts} {...s} />),
    confirm: (message, initial = false) =>
      ask((s) => <ConfirmPrompt message={message} initial={initial} {...s} />),
  };
}
