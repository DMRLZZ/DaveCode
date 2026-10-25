import { join } from 'node:path';
import { Arch, build, Platform } from 'electron-builder';
import { prepare, root } from './stage.mjs';

if (process.platform !== 'win32') throw new Error('Build the Windows installer on Windows.');
if (process.arch !== 'x64')
  throw new Error('Build the x64 installer using an x64 Node.js runtime.');
const stage = await prepare();
await build({
  targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
  publish: 'never',
  projectDir: root,
  config: {
    appId: 'app.davecode.desktop',
    productName: 'DaveCode',
    electronVersion: '45.0.0',
    directories: { app: join(stage, 'app'), output: join(root, 'release') },
    files: ['dist/**', 'package.json', 'LICENSE'],
    extraResources: [
      { from: join(stage, 'runtime'), to: 'runtime' },
      { from: join(stage, 'node'), to: 'node' },
    ],
    npmRebuild: false,
    win: {
      target: 'nsis',
      icon: join(root, 'assets/icon.ico'),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands these macros.
      artifactName: 'DaveCode-Setup-${version}-${arch}.${ext}',
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'DaveCode',
      deleteAppDataOnUninstall: false,
    },
  },
});
