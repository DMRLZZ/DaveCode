import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_IDS, AGENTS, agentCommand, detectAgents, onPath } from './agents';
import { PANE_KINDS } from './panes';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'davecode-agents-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The page's list, read as text: the desktop package does not compile the UI's sources. */
function pageAgents(): { id: string; command: string; yolo: boolean }[] {
  const source = readFileSync(join(__dirname, '../../ui/src/lib/agents.ts'), 'utf8');
  const list = source.slice(source.indexOf('export const AGENT_LIST'));
  return [
    ...list.matchAll(/id: '([^']+)',[\s\S]*?command: '([^']+)',[\s\S]*?yolo: (true|false),/g),
  ].map((m) => ({ id: m[1] as string, command: m[2] as string, yolo: m[3] === 'true' }));
}

describe('agent registry', () => {
  it('is the same list the page shows', () => {
    const AGENT_LIST = pageAgents();
    expect(AGENT_LIST.map((agent) => agent.id)).toEqual(AGENT_IDS);
    expect(PANE_KINDS).toEqual(['shell', ...AGENT_IDS]);
    for (const agent of AGENT_LIST) {
      const own = AGENTS[agent.id as keyof typeof AGENTS];
      expect(agent.yolo).toBe(own.yolo.length > 0);
      expect(agent.command).toBe(own.command);
    }
  });

  it('adds the YOLO flag only when asked and only where the agent has one', () => {
    expect(agentCommand('claude', false)).toBe('claude');
    expect(agentCommand('claude', true)).toBe('claude --dangerously-skip-permissions');
    expect(agentCommand('codex', true)).toBe('codex --dangerously-bypass-approvals-and-sandbox');
    expect(agentCommand('copilot', true)).toBe('copilot');
    expect(agentCommand('cursor', false)).toBe('cursor-agent');
  });

  it('only ever builds commands from plain words', () => {
    for (const id of AGENT_IDS) {
      for (const yolo of [false, true]) {
        expect(agentCommand(id, yolo)).toMatch(/^[a-z][a-z-]*(?: --?[a-z-]+)*$/);
      }
    }
  });
});

describe('onPath', () => {
  it('finds a command the way the shell would', () => {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude.cmd'), '');
    writeFileSync(join(bin, 'codex'), '');
    mkdirSync(join(bin, 'agy'));
    const windows = { PATH: `${dir};${bin}`, PATHEXT: '.EXE;.CMD' };
    expect(onPath('claude', windows, 'win32')).toBe(true);
    expect(onPath('codex', windows, 'win32')).toBe(true);
    // A folder with the command's name is not the command.
    expect(onPath('agy', windows, 'win32')).toBe(false);
    expect(onPath('gemini', windows, 'win32')).toBe(false);
    expect(onPath('codex', {}, 'win32')).toBe(false);
  });

  // A Windows temp folder has a drive letter, which a POSIX PATH cannot hold.
  it.skipIf(process.platform === 'win32')('reads a POSIX PATH', () => {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'codex'), '');
    const posix = { PATH: `/nowhere:${bin}` };
    expect(onPath('codex', posix, 'linux')).toBe(true);
    expect(onPath('claude', posix, 'linux')).toBe(false);
    expect(onPath('codex', {}, 'linux')).toBe(false);
  });

  it('lists every agent with whether it is installed', () => {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'opencode.exe'), '');
    const found = detectAgents({ PATH: bin, PATHEXT: '.EXE' }, 'win32');
    expect(found.map((a) => a.id)).toEqual(AGENT_IDS);
    expect(found.filter((a) => a.installed).map((a) => a.id)).toEqual(['opencode']);
  });
});
