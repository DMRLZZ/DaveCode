import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';

/** Opt-in acceptance harness for our own packaged window, always with a disposable home. */
export async function verifyWindow(
  window: BrowserWindow,
  gateway: string,
  token: string,
  output: string,
) {
  const health = await fetch(`${gateway}/api/health`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (health.status !== 200) throw new Error('health_failed');
  if ((await fetch(`${gateway}/api/health`)).status !== 401)
    throw new Error('unauthenticated_gateway');
  const deadline = Date.now() + 20_000;
  let rendered = false;
  while (Date.now() < deadline) {
    rendered = await window.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('button')].find(node => node.textContent === 'Continue on this device');
      if (button) button.click();
      return Boolean(document.querySelector('#workspace-composer'));
    })()`);
    if (rendered) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!rendered) throw new Error('workspace_not_rendered');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'desktop.png'), (await window.webContents.capturePage()).toPNG());
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify({
      status: 'passed',
      version: '0.3.0',
      url: gateway,
      workspace: true,
      authenticated: true,
    }),
  );
}
