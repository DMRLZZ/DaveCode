import { type ChildProcess, fork } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { readySchema } from './policy';

it('starts an isolated authenticated workspace and shuts down on desktop disconnect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'davecode-desktop-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  await mkdir(project);
  let child: ChildProcess | undefined;
  try {
    child = fork(fileURLToPath(new URL('./backend.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx', '--conditions=source'],
      env: { ...process.env, DAVECODE_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    const worker = child;
    const exited = new Promise<number | null>((resolve) => worker.once('exit', resolve));
    const ready = new Promise<string>((resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', () => reject(new Error('backend exited before startup')));
      worker.once('message', (message) => {
        const result = readySchema.safeParse(message);
        if (result.success) resolve(result.data.url);
        else reject(new Error('invalid backend handshake'));
      });
    });
    const token = 'desktop-test-token-00000000000000000000';
    worker.send({ type: 'start', home, project, token, cli: process.argv[1], dashboard: project });
    const url = await ready;
    expect((await fetch(`${url}/api/health`)).status).toBe(401);
    const response = await fetch(`${url}/api/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { graph: { tasks: unknown[] } }).graph.tasks).toEqual([]);
    worker.disconnect();
    expect(await exited).toBe(0);
    await expect(fetch(`${url}/api/health`)).rejects.toThrow();
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise<void>((resolve) => {
        child!.once('exit', () => resolve());
      });
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
