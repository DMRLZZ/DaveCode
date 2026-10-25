import { spawn } from 'node:child_process';
import { join } from 'node:path';
import electron from 'electron';
import { prepare, root } from './stage.mjs';

await prepare();
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [join(root, 'dist/main.cjs')], {
  stdio: 'inherit',
  env,
  windowsHide: false,
});
child.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
