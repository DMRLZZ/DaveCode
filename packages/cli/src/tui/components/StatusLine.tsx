import { Box, Text } from 'ink';
import { bar, formatTokens, levelStyle, percent, visibleWidth } from '../../ui/format';
import type { Theme } from '../../ui/theme';
import type { ChatState } from '../chat-state';
import { useTheme } from '../theme-context';

export interface StatusInfo {
  /** `in-process :54012` or the gateway URL. */
  where: string;
  inProcess: boolean;
  /** Transient message (e.g. "Press Ctrl+C again to exit"). */
  notice?: string;
}

/**
 * Left: model · account · failovers · tokens · 5h quota. Right: connection.
 * Segments are dropped from the end of the left side until the line fits.
 */
export function statusSegments(
  theme: Theme,
  state: ChatState,
  info: StatusInfo,
  width: number,
): { left: string; right: string } {
  const sep = theme.dim(' · ');
  const left: string[] = [theme.accent(state.model)];
  if (state.lastAccount) {
    const name = state.lastAccount.label ?? state.lastAccount.id;
    left.push(
      `${name}${state.lastAccount.provider ? theme.dim(` (${state.lastAccount.provider})`) : ''}`,
    );
  }
  const failovers =
    state.totalFailovers > 0
      ? theme.warn(`${state.lastFailovers}/${state.totalFailovers} failovers`)
      : theme.dim('0 failovers');
  left.push(failovers);
  const arrows = theme.unicode ? ['↑', '↓'] : ['in', 'out'];
  left.push(
    theme.dim(
      `${formatTokens(state.tokens.prompt)}${arrows[0]} ${formatTokens(state.tokens.completion)}${arrows[1]}`,
    ),
  );
  if (state.quota5h !== undefined) {
    left.push(
      `${theme.dim('5h')} ${bar(theme, state.quota5h, 6)} ${levelStyle(theme, state.quota5h)(percent(state.quota5h))}`,
    );
  }

  const dot = theme.glyph.dot;
  let right: string;
  if (info.notice) right = theme.warn(info.notice);
  else if (state.connection === 'online') {
    right = `${theme.ok(dot)} ${theme.dim(info.inProcess ? `${info.where}` : 'connected')}`;
  } else if (state.connection === 'connecting') right = theme.dim(`${dot} connecting`);
  else right = theme.error(`${dot} offline`);

  // Drop segments (least important last) until everything fits on one line.
  const priorities = [0, 1, 2, 4, 3];
  let kept = left.map((_, i) => i);
  const render = () => kept.map((i) => left[i]).join(sep);
  while (kept.length > 1 && visibleWidth(render()) + visibleWidth(right) + 2 > width) {
    const drop = [...priorities].reverse().find((p) => kept.includes(p) && p !== 0);
    if (drop === undefined) break;
    kept = kept.filter((i) => i !== drop);
  }
  return { left: render(), right };
}

export function StatusLine({
  state,
  info,
  width,
}: {
  state: ChatState;
  info: StatusInfo;
  width: number;
}) {
  const theme = useTheme();
  const { left, right } = statusSegments(theme, state, info, width - 2);
  return (
    <Box width={width} justifyContent="space-between" paddingX={1}>
      <Text wrap="truncate-end">{left}</Text>
      <Text wrap="truncate-start">{right}</Text>
    </Box>
  );
}
