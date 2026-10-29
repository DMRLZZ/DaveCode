/** Slash commands understood by the chat TUI. */

export type SlashName =
  | 'help'
  | 'model'
  | 'connect'
  | 'route'
  | 'accounts'
  | 'tasks'
  | 'status'
  | 'login'
  | 'logout'
  | 'account'
  | 'clear'
  | 'exit';

export interface SlashCommand {
  name: SlashName;
  args?: string;
  description: string;
  aliases?: string[];
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'model', args: '[id]', description: 'show models or switch, e.g. /model davecode/auto' },
  {
    name: 'connect',
    description: 'connect Claude Code, Codex or Antigravity, or sign in to one again',
  },
  { name: 'route', description: 'routes and their failover targets' },
  { name: 'accounts', description: 'accounts with 5h quota usage' },
  { name: 'tasks', description: 'the project task graph' },
  { name: 'status', description: 'model, agents and whether they are signed in' },
  { name: 'login', description: 'sign in to your DaveCode account in the browser' },
  { name: 'logout', description: 'sign out of your DaveCode account' },
  { name: 'account', description: 'the signed-in DaveCode account' },
  { name: 'clear', description: 'clear the transcript and start a new conversation' },
  { name: 'help', description: 'commands and keyboard shortcuts', aliases: ['?'] },
  { name: 'exit', description: 'quit DaveCode', aliases: ['quit', 'q'] },
];

export type SlashParse =
  | { kind: 'command'; command: SlashCommand; args: string }
  | { kind: 'unknown'; name: string }
  | { kind: 'none' };

/** `/model gpt-5` → the model command with args `gpt-5`. Text without a leading `/` is a prompt. */
export function parseSlash(input: string): SlashParse {
  const text = input.trim();
  if (!text.startsWith('/') || text.startsWith('//')) return { kind: 'none' };
  const [head = '', ...rest] = text.slice(1).split(/\s+/);
  const name = head.toLowerCase();
  if (!name) return { kind: 'unknown', name: '' };
  const command = SLASH_COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
  if (!command) return { kind: 'unknown', name };
  return { kind: 'command', command, args: rest.join(' ').trim() };
}

/** Commands matching what has been typed so far (only while typing the command name). */
export function slashSuggestions(input: string): SlashCommand[] {
  if (!input.startsWith('/') || /\s/.test(input)) return [];
  const prefix = input.slice(1).toLowerCase();
  return SLASH_COMMANDS.filter(
    (c) => c.name.startsWith(prefix) || c.aliases?.some((a) => a.startsWith(prefix) && prefix),
  );
}

export const KEY_HINTS: ReadonlyArray<[string, string]> = [
  ['Enter', 'send'],
  ['Shift+Enter, Ctrl+J or \\ Enter', 'new line'],
  ['↑ / ↓', 'move between lines, then through history'],
  ['/', 'command menu: ↑ / ↓ to choose, Enter to run, Tab to fill, Esc to close'],
  ['Esc', 'cancel the response in flight'],
  ['Ctrl+U / Ctrl+K / Ctrl+W', 'delete to line start / line end / previous word'],
  ['Ctrl+C twice', 'exit'],
];
