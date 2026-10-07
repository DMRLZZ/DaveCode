/**
 * Pure multiline text-editing model for the chat input. Positions are indexes into the array
 * of code points so emoji and other astral characters move as one unit.
 */

export interface EditorState {
  /** Code points of the buffer. */
  chars: string[];
  /** Cursor position, 0..chars.length. */
  cursor: number;
}

export const emptyEditor: EditorState = { chars: [], cursor: 0 };

export function fromText(text: string): EditorState {
  const chars = [...text];
  return { chars, cursor: chars.length };
}

export function textOf(state: EditorState): string {
  return state.chars.join('');
}

/** Normalise pasted or typed text: CRLF/CR → LF, tabs → two spaces, other controls dropped. */
export function normalizeInput(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, '  ')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: dropping control characters
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
  );
}

export function insert(state: EditorState, text: string): EditorState {
  const add = [...normalizeInput(text)];
  if (add.length === 0) return state;
  const chars = [...state.chars.slice(0, state.cursor), ...add, ...state.chars.slice(state.cursor)];
  return { chars, cursor: state.cursor + add.length };
}

export function backspace(state: EditorState): EditorState {
  if (state.cursor === 0) return state;
  const chars = [...state.chars.slice(0, state.cursor - 1), ...state.chars.slice(state.cursor)];
  return { chars, cursor: state.cursor - 1 };
}

export function deleteForward(state: EditorState): EditorState {
  if (state.cursor >= state.chars.length) return state;
  const chars = [...state.chars.slice(0, state.cursor), ...state.chars.slice(state.cursor + 1)];
  return { chars, cursor: state.cursor };
}

export function left(state: EditorState): EditorState {
  return { ...state, cursor: Math.max(0, state.cursor - 1) };
}

export function right(state: EditorState): EditorState {
  return { ...state, cursor: Math.min(state.chars.length, state.cursor + 1) };
}

/** Line and column of the cursor. */
export function position(state: EditorState): { line: number; column: number } {
  let line = 0;
  let column = 0;
  for (let i = 0; i < state.cursor; i++) {
    if (state.chars[i] === '\n') {
      line++;
      column = 0;
    } else {
      column++;
    }
  }
  return { line, column };
}

export function lines(state: EditorState): string[][] {
  const out: string[][] = [[]];
  for (const ch of state.chars) {
    if (ch === '\n') out.push([]);
    else out[out.length - 1]!.push(ch);
  }
  return out;
}

function offsetOf(all: string[][], line: number, column: number): number {
  let offset = 0;
  for (let i = 0; i < line; i++) offset += all[i]!.length + 1;
  return offset + Math.min(column, all[line]!.length);
}

export function lineCount(state: EditorState): number {
  return lines(state).length;
}

/** Move up one line, keeping the column. Returns `undefined` on the first line. */
export function up(state: EditorState): EditorState | undefined {
  const { line, column } = position(state);
  if (line === 0) return undefined;
  return { ...state, cursor: offsetOf(lines(state), line - 1, column) };
}

/** Move down one line, keeping the column. Returns `undefined` on the last line. */
export function down(state: EditorState): EditorState | undefined {
  const all = lines(state);
  const { line, column } = position(state);
  if (line >= all.length - 1) return undefined;
  return { ...state, cursor: offsetOf(all, line + 1, column) };
}

export function lineStart(state: EditorState): EditorState {
  const { line } = position(state);
  return { ...state, cursor: offsetOf(lines(state), line, 0) };
}

export function lineEnd(state: EditorState): EditorState {
  const all = lines(state);
  const { line } = position(state);
  return { ...state, cursor: offsetOf(all, line, all[line]!.length) };
}

/** Ctrl+U: delete from the start of the line to the cursor. */
export function killToLineStart(state: EditorState): EditorState {
  const start = lineStart(state).cursor;
  if (start === state.cursor) return state;
  return {
    chars: [...state.chars.slice(0, start), ...state.chars.slice(state.cursor)],
    cursor: start,
  };
}

/** Ctrl+K: delete from the cursor to the end of the line. */
export function killToLineEnd(state: EditorState): EditorState {
  const end = lineEnd(state).cursor;
  return {
    chars: [...state.chars.slice(0, state.cursor), ...state.chars.slice(end)],
    cursor: state.cursor,
  };
}

/** Ctrl+W: delete the word before the cursor (and the spaces after it). */
export function deleteWordBack(state: EditorState): EditorState {
  let i = state.cursor;
  while (i > 0 && /[ \t]/.test(state.chars[i - 1]!)) i--;
  while (i > 0 && !/[\s]/.test(state.chars[i - 1]!)) i--;
  if (i === state.cursor) return backspace(state);
  return { chars: [...state.chars.slice(0, i), ...state.chars.slice(state.cursor)], cursor: i };
}

/**
 * Enter at the end of a line that ends with a backslash continues on a new line instead of
 * submitting (the Claude Code convention for terminals that cannot send Shift+Enter).
 */
export function continuesLine(state: EditorState): boolean {
  return state.cursor > 0 && state.chars[state.cursor - 1] === '\\';
}

export function newlineAfterBackslash(state: EditorState): EditorState {
  return insert(backspace(state), '\n');
}
