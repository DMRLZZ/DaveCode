import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { which } from './proc';

/** Open only a loopback workspace, without a shell or credentials in the URL. */
export async function openAppWindow(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const target = new URL(url);
  if (
    !['http:', 'https:'].includes(target.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new Error('App windows require a loopback workspace URL without credentials.');
  const win = process.platform === 'win32';
  const candidates = win
    ? [
        join(
          env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
          'Microsoft',
          'Edge',
          'Application',
          'msedge.exe',
        ),
        join(
          env.ProgramFiles ?? 'C:\\Program Files',
          'Google',
          'Chrome',
          'Application',
          'chrome.exe',
        ),
        ...(env.LOCALAPPDATA
          ? [
              join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
              join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            ]
          : []),
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ]
      : ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'];
  const executable = candidates.map((candidate) => which(candidate, env)).find(Boolean);
  if (!executable) return false;
  return new Promise((resolve) => {
    const child = spawn(executable, [`--app=${target.origin}/`], {
      env,
      shell: false,
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}
