import { Box, Text } from 'ink';
import { useTheme } from '../theme-context';

export interface PickerOption {
  value: string;
  label: string;
  hint?: string;
}

/** An inline list chosen with ↑/↓ and Enter, or a number; replaces the input box while open. */
export function Picker({
  title,
  options,
  index,
}: {
  title: string;
  options: readonly PickerOption[];
  index: number;
}) {
  const theme = useTheme();
  const numbered = options.length <= 9;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{title}</Text>
      {options.map((option, i) => {
        const on = i === index;
        return (
          <Text key={option.value} dimColor={!on && theme.ink.dim}>
            {on ? '› ' : '  '}
            {numbered ? `${i + 1}. ` : ''}
            <Text bold={on}>{option.label}</Text>
            {option.hint ? <Text dimColor={theme.ink.dim}> {option.hint}</Text> : null}
          </Text>
        );
      })}
      <Text dimColor={theme.ink.dim}>
        ↑↓ select · enter choose{numbered ? ' · 1-9' : ''} · esc cancel
      </Text>
    </Box>
  );
}
