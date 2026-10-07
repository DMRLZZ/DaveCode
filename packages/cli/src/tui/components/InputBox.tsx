import { Box, Text } from 'ink';
import { type EditorState, lines, position } from '../editor';
import type { SlashCommand } from '../slash';
import { useTheme } from '../theme-context';

/** Split a line around the cursor so the cursor cell can be drawn inverted. */
export function cursorParts(
  line: string[],
  column: number | undefined,
): { before: string; at: string; after: string } {
  if (column === undefined) return { before: line.join(''), at: '', after: '' };
  return {
    before: line.slice(0, column).join(''),
    at: line[column] ?? ' ',
    after: line.slice(column + 1).join(''),
  };
}

export function InputBox({
  editor,
  width,
  placeholder,
  disabled,
}: {
  editor: EditorState;
  width: number;
  placeholder: string;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const all = lines(editor);
  const cursor = position(editor);
  const empty = editor.chars.length === 0;
  return (
    <Box
      borderStyle={theme.unicode ? 'round' : 'classic'}
      borderDimColor={theme.ink.dim}
      flexDirection="column"
      paddingX={1}
      width={width}
    >
      {all.map((line, i) => {
        const parts = cursorParts(line, !disabled && i === cursor.line ? cursor.column : undefined);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity beyond position
          <Box key={i}>
            <Box width={2} flexShrink={0}>
              <Text color={i === 0 ? theme.ink.accent : undefined}>
                {i === 0 ? theme.glyph.prompt : ''}
              </Text>
            </Box>
            {empty && i === 0 ? (
              <Text>
                {disabled ? null : <Text inverse> </Text>}
                <Text dimColor={theme.ink.dim}>{placeholder}</Text>
              </Text>
            ) : (
              <Text>
                {parts.before}
                {parts.at ? <Text inverse>{parts.at}</Text> : null}
                {parts.after}
              </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

export function SlashHints({ commands, width }: { commands: SlashCommand[]; width: number }) {
  const theme = useTheme();
  if (commands.length === 0) return null;
  const nameWidth =
    Math.max(...commands.map((c) => c.name.length + (c.args ? c.args.length + 1 : 0))) + 3;
  return (
    <Box flexDirection="column" paddingX={2} width={width}>
      {commands.map((c, i) => (
        <Text key={c.name} wrap="truncate-end">
          <Text color={i === 0 ? theme.ink.accent : undefined}>
            {`/${c.name}${c.args ? ` ${c.args}` : ''}`.padEnd(nameWidth)}
          </Text>
          <Text dimColor={theme.ink.dim}>{c.description}</Text>
        </Text>
      ))}
    </Box>
  );
}
