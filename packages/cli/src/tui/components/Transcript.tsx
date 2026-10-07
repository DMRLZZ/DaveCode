import { Box, Text } from 'ink';
import { formatTokens } from '../../ui/format';
import type { Entry, EntryMeta, StreamingState } from '../chat-state';
import { useTheme } from '../theme-context';
import { Spinner } from './Spinner';

/** `claude-cli · work · 1.2k tok · 830ms · 1 failover` under an assistant reply. */
export function metaLine(meta: EntryMeta): string {
  const parts: string[] = [];
  if (meta.accountLabel ?? meta.accountId) {
    parts.push([meta.provider, meta.accountLabel ?? meta.accountId].filter(Boolean).join(' · '));
  }
  if (meta.model) parts.push(meta.model);
  if (meta.tokens !== undefined)
    parts.push(`${meta.estimated ? '~' : ''}${formatTokens(meta.tokens)} tok`);
  if (meta.latencyMs !== undefined) parts.push(`${(meta.latencyMs / 1000).toFixed(1)}s`);
  if (meta.failovers) parts.push(`${meta.failovers} failover${meta.failovers === 1 ? '' : 's'}`);
  if (meta.cancelled) parts.push('cancelled');
  return parts.join(' · ');
}

function Marker({ color, glyph }: { color: string | undefined; glyph: string }) {
  return (
    <Box width={2} flexShrink={0}>
      <Text color={color}>{glyph}</Text>
    </Box>
  );
}

export function EntryView({ entry }: { entry: Entry }) {
  const theme = useTheme();
  switch (entry.kind) {
    case 'banner':
      return (
        <Box marginBottom={1}>
          <Text>{entry.text}</Text>
        </Box>
      );
    case 'user':
      return (
        <Box marginBottom={1}>
          <Marker color={theme.ink.accent} glyph={theme.glyph.prompt} />
          <Text dimColor={theme.ink.dim}>{entry.text}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Marker color={theme.ink.accent} glyph={theme.glyph.dot} />
            <Text>
              {entry.text || (entry.meta?.cancelled ? '(cancelled before any output)' : '')}
            </Text>
          </Box>
          {entry.meta ? (
            <Box paddingLeft={2}>
              <Text dimColor={theme.ink.dim}>{metaLine(entry.meta)}</Text>
            </Box>
          ) : null}
        </Box>
      );
    case 'error':
      return (
        <Box marginBottom={1}>
          <Marker color={theme.ink.error} glyph={theme.glyph.fail} />
          <Text color={theme.ink.error}>{entry.text}</Text>
        </Box>
      );
    default:
      return (
        <Box marginBottom={1} paddingLeft={2}>
          <Text>{entry.text}</Text>
        </Box>
      );
  }
}

/** The reply being streamed: spinner until the first token, then the growing text. */
export function StreamingView({ streaming, now }: { streaming: StreamingState; now: number }) {
  const theme = useTheme();
  const seconds = Math.max(0, (now - streaming.startedAt) / 1000).toFixed(0);
  return (
    <Box flexDirection="column" marginBottom={1}>
      {streaming.text ? (
        <Box>
          <Marker color={theme.ink.accent} glyph={theme.glyph.dot} />
          <Text>{streaming.text}</Text>
        </Box>
      ) : null}
      <Box paddingLeft={streaming.text ? 2 : 0}>
        <Spinner />
        <Text dimColor={theme.ink.dim}>
          {' '}
          {streaming.text ? 'streaming' : 'thinking'} {seconds}s · esc to cancel
        </Text>
      </Box>
    </Box>
  );
}
