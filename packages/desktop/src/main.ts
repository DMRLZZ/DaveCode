import { type ChildProcess, fork, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { externalUrl, readySchema, sameOrigin } from './policy';
import { verifyWindow } from './smoke';

let window: BrowserWindow | undefined;
let backend: ChildProcess | undefined;
let gateway: string | undefined;
let switching = false;
let quitting = false;
const token = randomBytes(32).toString('hex');
const bundle = app.isPackaged ? process.resourcesPath : join(__dirname, '..', '.stage');
const runtimeDir = join(bundle, 'runtime');
const nodeBinary = join(bundle, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
const home = process.env.DAVECODE_HOME ?? join(homedir(), '.davecode');
const welcome = pathToFileURL(join(__dirname, 'welcome.html')).href;
const smokeOutput = process.env.DAVECODE_DESKTOP_SMOKE_DIR;
function checkpoint(stage: string) {
  if (!smokeOutput) return;
  mkdirSync(smokeOutput, { recursive: true });
  writeFileSync(
    join(smokeOutput, 'startup.json'),
    JSON.stringify({ stage, packaged: app.isPackaged }),
  );
  console.log(`Desktop startup: ${stage}`);
}

app.setName('DaveCode');
checkpoint('main-loaded');
if (process.env.DAVECODE_DESKTOP_SMOKE_DIR) {
  const profile = join(process.env.DAVECODE_DESKTOP_SMOKE_DIR, 'profile');
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
}

async function stopBackend(): Promise<void> {
  gateway = undefined;
  const child = backend;
  backend = undefined;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (child.pid && process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else child.kill('SIGKILL');
      resolve();
    }, 15_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    if (child.connected) child.send({ type: 'stop' });
    else child.kill();
  });
}

async function openProject(project: string): Promise<void> {
  if (switching || !window) return;
  switching = true;
  try {
    if (!existsSync(join(project, '.davecode', 'STATE.md'))) {
      const result = await dialog.showMessageBox(window, {
        type: 'question',
        buttons: ['Set up project', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        title: 'Open project',
        message: 'Set up DaveCode in this folder?',
        detail: 'DaveCode will create a .davecode folder for this project’s plans and progress.',
      });
      if (result.response !== 0) {
        return;
      }
    }
    await stopBackend();
    checkpoint('starting-backend');
    const child = fork(join(runtimeDir, 'backend.mjs'), [], {
      execPath: nodeBinary,
      execArgv: [],
      cwd: project,
      env: {
        ...process.env,
        DAVECODE_HOME: home,
        PATH: `${dirname(nodeBinary)}${delimiter}${process.env.PATH ?? ''}`,
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    backend = child;
    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('startup_timeout')), 30_000);
      const fail = () => {
        clearTimeout(timeout);
        reject(new Error('startup_failed'));
      };
      child.once('error', fail);
      child.once('exit', fail);
      child.on('message', (message) => {
        const ready = readySchema.safeParse(message);
        if (!ready.success) {
          fail();
          return;
        }
        clearTimeout(timeout);
        resolve(ready.data.url);
      });
      child.send({
        type: 'start',
        project,
        home,
        token,
        cli: join(runtimeDir, 'cli', 'bin', 'davecode.js'),
        dashboard: join(runtimeDir, 'cli', 'dist', 'dashboard'),
      });
    });
    if (quitting || !window) return;
    gateway = new URL(url).origin;
    checkpoint('backend-ready');
    await window.loadURL(`${url}/#/`);
    checkpoint('workspace-loaded');
    child.once('exit', () => {
      if (backend !== child || quitting) return;
      backend = undefined;
      gateway = undefined;
      void window?.loadURL(welcome);
      dialog.showErrorBox(
        'Workspace stopped',
        'The local service stopped. Open your project again to restart it.',
      );
    });
  } catch {
    checkpoint('project-start-failed');
    await stopBackend();
    if (quitting || !window) return;
    if (smokeOutput) {
      app.exit(1);
      return;
    }
    await window.loadURL(welcome);
    dialog.showErrorBox(
      'Could not open project',
      'DaveCode could not start the local workspace. Check that the folder is writable and try again.',
    );
  } finally {
    switching = false;
  }
}

async function chooseProject(): Promise<void> {
  if (!window || switching) return;
  const selection = await dialog.showOpenDialog(window, {
    title: 'Open a project',
    properties: ['openDirectory', 'createDirectory'],
  });
  const project = selection.filePaths[0];
  if (!selection.canceled && project) await openProject(project);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  void app.whenReady().then(async () => {
    checkpoint('app-ready');
    app.setAppUserModelId('app.davecode.desktop');
    window = new BrowserWindow({
      width: 1280,
      height: 840,
      minWidth: 940,
      minHeight: 660,
      title: 'DaveCode',
      icon: join(__dirname, 'icon.png'),
      backgroundColor: '#000000',
      show: false,
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.on('closed', () => {
      window = undefined;
      app.quit();
    });
    const session = window.webContents.session;
    window.webContents.on('did-finish-load', () => {
      if (smokeOutput && window) {
        void window.webContents
          .capturePage()
          .then((image) => writeFileSync(join(smokeOutput, 'startup.png'), image.toPNG()))
          // A hidden window cannot always be captured; the screenshot is diagnostic only.
          .catch(() => {});
      }
    });
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.webRequest.onBeforeSendHeaders((details, callback) => {
      // A per-launch credential stays in the main process. It never enters a URL, preload,
      // localStorage or renderer JavaScript and is only attached to this gateway's requests.
      if (sameOrigin(details.url, gateway))
        details.requestHeaders.Authorization = `Bearer ${token}`;
      callback({ requestHeaders: details.requestHeaders });
    });
    session.webRequest.onHeadersReceived((details, callback) => {
      const headers = details.responseHeaders ?? {};
      if (sameOrigin(details.url, gateway)) {
        headers['Content-Security-Policy'] = [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'",
        ];
      }
      callback({ responseHeaders: headers });
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (sameOrigin(url, gateway) || url === welcome) return;
      event.preventDefault();
      if (externalUrl(url)) void shell.openExternal(url);
    });
    window.webContents.on('will-redirect', (event, url) => {
      if (!sameOrigin(url, gateway)) event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (externalUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    ipcMain.handle('desktop:choose-project', async (event) => {
      const current = window;
      const url = event.senderFrame?.url;
      if (
        !current ||
        event.sender !== current.webContents ||
        event.senderFrame !== current.webContents.mainFrame ||
        !url ||
        (url !== welcome && !sameOrigin(url, gateway))
      )
        return;
      await chooseProject();
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'File',
          submenu: [
            {
              label: 'Open project…',
              accelerator: 'CmdOrCtrl+O',
              click: () => void chooseProject(),
            },
            {
              label: 'Close project',
              click: () => void stopBackend().then(() => window?.loadURL(welcome)),
            },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
        { role: 'editMenu' },
        {
          label: 'View',
          submenu: [
            { role: 'reload' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { role: 'togglefullscreen' },
          ],
        },
        {
          label: 'Help',
          submenu: [
            {
              label: 'DaveCode on GitHub',
              click: () => void shell.openExternal('https://github.com/DMRLZZ/DaveCode'),
            },
          ],
        },
      ]),
    );
    window.once('ready-to-show', () => window?.show());
    await window.loadURL(welcome);
    checkpoint('welcome-loaded');
    const project = process.argv
      .find((value) => value.startsWith('--project='))
      ?.slice('--project='.length);
    if (project) await openProject(resolve(project));
    const smoke = process.env.DAVECODE_DESKTOP_SMOKE_DIR;
    if (smoke) {
      try {
        if (!gateway || !window) throw new Error('no_gateway');
        await verifyWindow(window, gateway, token, smoke);
        await stopBackend();
        app.exit(0);
      } catch (error) {
        console.error(
          'Desktop acceptance failed:',
          error instanceof Error ? error.message : 'unknown',
        );
        await stopBackend();
        app.exit(1);
      }
      return;
    }
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void stopBackend().finally(() => app.exit(0));
  });
}
