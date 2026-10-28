import { spawn } from 'node:child_process';

export type Launcher = (command: string, args: string[]) => Promise<boolean>;

const detached: Launcher = (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });

/**
 * Open an http(s) URL in the default browser. Returns false when nothing could be launched, so
 * the caller can print the URL instead.
 */
export async function openBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  launch: Launcher = detached,
): Promise<boolean> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const target = parsed.toString();
  // No shell is involved, so the URL is never interpreted as a command.
  if (platform === 'win32') return launch('rundll32', ['url.dll,FileProtocolHandler', target]);
  if (platform === 'darwin') return launch('open', [target]);
  return launch('xdg-open', [target]);
}
