import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare, root } from './stage.mjs';

const packaged = process.argv.includes('--packaged');
if (!packaged) await prepare();
const temp = await mkdtemp(join(tmpdir(), 'davecode-desktop-acceptance-'));
const project = join(temp, 'project');
const brain = join(project, '.davecode');
const output = join(root, 'release/smoke');
await mkdir(brain, { recursive: true });
await writeFile(join(brain, 'STATE.md'), '# Acceptance project\n');
await writeFile(join(brain, 'ARCHITECTURE.md'), '# Acceptance architecture\n');
await writeFile(join(brain, 'TASK_GRAPH.json'), JSON.stringify({ version: 1, tasks: [] }));
const env = {
  ...process.env,
  DAVECODE_HOME: join(temp, 'home'),
  DAVECODE_DESKTOP_SMOKE_DIR: output,
};
delete env.ELECTRON_RUN_AS_NODE;
const UNPACKED = {
  win32: 'release/win-unpacked/DaveCode.exe',
  darwin: 'release/mac-arm64/DaveCode.app/Contents/MacOS/DaveCode',
  linux: 'release/linux-unpacked/davecode-desktop',
};
const command = packaged
  ? join(root, UNPACKED[process.platform])
  : (await import('electron')).default;
const args = [
  ...(packaged ? [] : [join(root, 'dist/main.cjs')]),
  `--project=${project}`,
  // CI containers lack the setuid helper Chromium's Linux sandbox needs.
  ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
];
try {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit', windowsHide: false });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Desktop acceptance timed out'));
    }, 60_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      code === 0 ? resolve() : reject(new Error(`Desktop acceptance exited ${code}`));
    });
  });
  const report = JSON.parse(await readFile(join(output, 'result.json'), 'utf8'));
  await fetch(`${report.url}/api/health`).then(
    () => {
      throw new Error('Gateway remained running after exit');
    },
    () => {},
  );
  console.log(
    JSON.stringify({ ...report, shutdown: true, screenshot: join(output, 'desktop.png') }),
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
