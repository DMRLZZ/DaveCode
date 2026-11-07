import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

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

/**
 * The only packages installed as files. Everything else is bundled into a few scripts: Windows
 * Defender scans every file the installer writes, and thousands of tiny module files made the
 * installation take minutes and the first launch take most of a minute.
 * - better-sqlite3 is native.
 * - js-tiktoken is loaded through `createRequire` at runtime, which a bundler cannot follow.
 * (The panes' native @lydell/node-pty is added in `prepare`.)
 */
const UNBUNDLED = ['better-sqlite3', 'js-tiktoken'];

/** Optional or development-only imports that are never installed. */
const NEVER_INSTALLED = ['playwright-core', 'react-devtools-core'];

// Bundled CommonJS code calls `require` for Node built-ins, which ESM output lacks.
const REQUIRE_BANNER =
  "import { createRequire as __davecodeRequire } from 'node:module'; const require = __davecodeRequire(import.meta.url);";

const WORKSPACE = {
  '@davecode/core': '../../core/src/index.ts',
  '@davecode/server': '../../server/src/index.ts',
  '@dmrlzz/davecode/runtime': '../../cli/src/runtime.ts',
};

/** Builds the backend from the workspace sources, as `build.mjs` does for development. */
const workspaceSources = {
  name: 'workspace',
  setup(builder) {
    builder.onResolve({ filter: /^@(davecode|dmrlzz)\// }, (args) => {
      const source = WORKSPACE[args.path];
      if (!source) throw new Error(`Unknown workspace import: ${args.path}`);
      return { path: fileURLToPath(new URL(source, import.meta.url)) };
    });
  },
};

function dependencies() {
  const require = createRequire(join(cliRoot, 'package.json'));
  return Object.fromEntries(
    UNBUNDLED.map((name) => {
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
  // The panes' native PTY ships prebuilt N-API binaries, so Electron can load it directly.
  const deps = {
    ...dependencies(),
    '@lydell/node-pty': desktop.dependencies['@lydell/node-pty'],
  };
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
    // A previous build may have installed packages that are now bundled.
    await rm(join(runtime, 'node_modules'), { recursive: true, force: true });
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
  const external = [...UNBUNDLED, ...NEVER_INSTALLED, '@lydell/node-pty'];
  const common = {
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external,
    banner: { js: REQUIRE_BANNER },
    legalComments: 'none',
    logLevel: 'warning',
  };
  await build({
    ...common,
    absWorkingDir: root,
    entryPoints: ['src/backend.ts'],
    outfile: join(runtime, 'backend.mjs'),
    conditions: ['source'],
    plugins: [workspaceSources],
  });
  // The CLI (used for vendor sign-in terminals) keeps its lazily loaded command chunks.
  await rm(join(runtime, 'cli'), { recursive: true, force: true });
  await build({
    ...common,
    absWorkingDir: cliRoot,
    entryPoints: { index: 'dist/index.js' },
    outdir: join(runtime, 'cli/dist'),
    splitting: true,
    jsx: 'automatic',
  });
  await cp(join(cliRoot, 'dist/dashboard'), join(runtime, 'cli/dist/dashboard'), {
    recursive: true,
  });
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
