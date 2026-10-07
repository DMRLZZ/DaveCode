import { Text, useAnimation } from 'ink';
import { useTheme } from '../theme-context';

const UNICODE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ASCII_FRAMES = ['-', '\\', '|', '/'];

export function Spinner({ active = true }: { active?: boolean }) {
  const theme = useTheme();
  const frames = theme.unicode ? UNICODE_FRAMES : ASCII_FRAMES;
  const { frame } = useAnimation({ interval: 80, isActive: active });
  return <Text color={theme.ink.accent}>{frames[frame % frames.length]}</Text>;
}
