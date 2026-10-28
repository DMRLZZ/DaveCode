import { Box, Text } from 'ink';
import { bar, formatTokens, levelStyle, percent, visibleWidth } from '../../ui/format';
import type { Theme } from '../../ui/theme';
import type { ChatState } from '../chat-state';
import { useTheme } from '../theme-context';

export interface StatusInfo {
  /** Transient message (e.g. "Press Ctrl+C again to exit"). */
  notice?: string;
}

/**
 * Left: model · account · failovers · tokens · 5h quota, each shown only once it says
 * something. Right: a notice, or the connection when it is not healthy.
 * Segments are dropped from the end of the left side until the line fits.
 */
export function statusSegments(
  theme: Theme,
  state: ChatState,
  info: StatusInfo,
  width: number,
): { left: string; right: string } {
  const sep = theme.dim(' · ');
  // [priority, text]: lower priorities are dropped first in narrow terminals.
  const left: Array<[number, string]> = [[9, theme.accent(state.model)]];
  if (state.lastAccount) {
    const name = state.lastAccount.label ?? state.lastAccount.id;
    left.push([
      8,
      `${name}${state.lastAccount.provider ? theme.dim(` (${state.lastAccount.provider})`) : ''}`,
    ]);
  }
  if (state.totalFailovers > 0) {
    left.push([7, theme.warn(`${state.lastFailovers}/${state.totalFailovers} failovers`)]);
  }
  if (state.tokens.prompt + state.tokens.completion > 0) {
    const arrows = theme.unicode ? ['↑', '↓'] : ['in', 'out'];
    left.push([
      5,
      theme.dim(
        `${formatTokens(state.tokens.prompt)}${arrows[0]} ${formatTokens(state.tokens.completion)}${arrows[1]}`,
      ),
    ]);
  }
  if (state.quota5h !== undefined) {
    left.push([
      6,
      `${theme.dim('5h')} ${bar(theme, state.quota5h, 6)} ${levelStyle(theme, state.quota5h)(percent(state.quota5h))}`,
    ]);
  }

  let right = '';
  if (info.notice) right = theme.warn(info.notice);
  else if (state.connection === 'connecting') right = theme.dim('connecting');
  else if (state.connection === 'offline') right = theme.error('offline');

  let kept = left;
  const render = () => kept.map(([, text]) => text).join(sep);
  while (kept.length > 1 && visibleWidth(render()) + visibleWidth(right) + 2 > width) {
    const lowest = Math.min(...kept.map(([p]) => p));
    kept = kept.filter(([p]) => p !== lowest);
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
