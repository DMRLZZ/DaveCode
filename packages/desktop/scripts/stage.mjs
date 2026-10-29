import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('..', import.meta.url));
const stage = join(root, '.stage');
const cliRoot = fileURLToPath(new URL('../../cli/', import.meta.url));
const cli = JSON.parse(await readFile(join(cliRoot, 'package.json'), 'utf8'));
const desktop = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

export function run(command, args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      windowsHide: true,
      env: process.env,
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

function dependencies() {
  const require = createRequire(join(cliRoot, 'package.json'));
  return Object.fromEntries(
    Object.keys(cli.dependencies).map((name) => {
      let directory = dirname(require.resolve(name));
      for (;;) {
        try {
          const pkg = require(`${directory}/package.json`);
          if (pkg.name === name) return [name, pkg.version];
        } catch {
          /* Find the dependency's manifest even when package exports hide it. */
        }
        const parent = dirname(directory);
        if (parent === directory) throw new Error(`Cannot resolve ${name}`);
        directory = parent;
      }
    }),
  );
}

export async function prepare() {
  const runtime = join(stage, 'runtime');
  const nodeDir = join(stage, 'node');
  const app = join(stage, 'app');
  await Promise.all([
    mkdir(runtime, { recursive: true }),
    mkdir(nodeDir, { recursive: true }),
    mkdir(app, { recursive: true }),
  ]);
  const deps = dependencies();
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        deps,
        node: process.version,
        arch: process.arch,
        platform: process.platform,
      }),
    )
    .digest('hex');
  let previous;
  try {
    previous = await readFile(join(runtime, '.fingerprint'), 'utf8');
  } catch {
    /* First build. */
  }
  await writeFile(
    join(runtime, 'package.json'),
    `${JSON.stringify({ name: 'davecode-desktop-runtime', version: desktop.version, private: true, type: 'module', dependencies: deps }, null, 2)}\n`,
  );
  if (previous !== fingerprint) {
    // npm runs under the exact Node binary that will ship, keeping SQLite's native ABI aligned.
    // pnpm is not npm: invoke the npm CLI installed alongside this Node distribution.
    const npmCli =
      process.platform === 'win32'
        ? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
        : join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
    await run(
      process.execPath,
      [npmCli, 'install', '--omit=dev', '--prefer-offline', '--no-audit', '--no-fund'],
      runtime,
    );
    await writeFile(join(runtime, '.fingerprint'), fingerprint);
  }
  await cp(process.execPath, join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'node'));
  const license = await fetch(
    `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!license.ok) throw new Error('Cannot obtain the bundled Node.js license.');
  await writeFile(join(nodeDir, 'LICENSE'), await license.text());
  await cp(join(root, 'dist/backend.mjs'), join(runtime, 'backend.mjs'));
  await cp(join(cliRoot, 'dist'), join(runtime, 'cli/dist'), { recursive: true });
  await cp(join(cliRoot, 'bin'), join(runtime, 'cli/bin'), { recursive: true });
  await cp(join(cliRoot, 'package.json'), join(runtime, 'cli/package.json'));
  await cp(join(root, 'dist'), join(app, 'dist'), { recursive: true });
  await cp(fileURLToPath(new URL('../../../LICENSE', import.meta.url)), join(app, 'LICENSE'));
  await writeFile(
    join(app, 'package.json'),
    `${JSON.stringify({ name: 'davecode-desktop', productName: 'DaveCode', version: desktop.version, description: desktop.description, author: 'DaveCode contributors', license: 'MIT', main: 'dist/main.cjs' }, null, 2)}\n`,
  );
  return stage;
}
