import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { Arch, build, Platform } from 'electron-builder';
import { prepare, root } from './stage.mjs';

// The bundled Node.js and SQLite are native, so each installer is built on its own platform.
const TARGETS = {
  win32: { platform: Platform.WINDOWS, target: 'nsis', arch: 'x64' },
  darwin: { platform: Platform.MAC, target: 'dmg', arch: 'arm64' },
  linux: { platform: Platform.LINUX, target: 'AppImage', arch: 'x64' },
};
const host = TARGETS[process.platform];
if (!host) throw new Error(`No desktop installer for ${process.platform}.`);
if (process.arch !== host.arch)
  throw new Error(`Build the ${process.platform} installer with a ${host.arch} Node.js runtime.`);

const stage = await prepare();
await build({
  targets: host.platform.createTarget([host.target], Arch[host.arch]),
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
    // electron-builder always drops node_modules from extraResources, which left the bundled
    // gateway without its dependencies. Copy them in before the installer is assembled.
    afterPack: async ({ appOutDir, packager }) => {
      const resources =
        process.platform === 'darwin'
          ? join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
          : join(appOutDir, 'resources');
      await cp(join(stage, 'runtime', 'node_modules'), join(resources, 'runtime', 'node_modules'), {
        recursive: true,
      });
    },
    npmRebuild: false,
    // Stable names, so https://github.com/…/releases/latest/download/<name> always works.
    win: {
      target: 'nsis',
      icon: join(root, 'assets/icon.ico'),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands these macros.
      artifactName: 'DaveCode-Setup-${arch}.${ext}',
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
    mac: {
      target: 'dmg',
      icon: join(root, 'assets/icon.png'),
      category: 'public.app-category.developer-tools',
      // Unsigned preview: no Apple Developer ID yet.
      identity: null,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands these macros.
      artifactName: 'DaveCode-macOS-${arch}.${ext}',
    },
    linux: {
      target: 'AppImage',
      icon: join(root, 'assets/icon.png'),
      category: 'Development',
      executableName: 'davecode-desktop',
      maintainer: 'DaveCode contributors',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands these macros.
      artifactName: 'DaveCode-Linux-${arch}.${ext}',
    },
  },
});
