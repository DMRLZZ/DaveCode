import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
      return Boolean(document.querySelector('[data-pane-live="true"] .xterm-rows'));
    })()`);
    if (rendered) break;
    await sleep(200);
  }
  if (!rendered) {
    const page = await window.webContents.executeJavaScript(
      'location.hash + " | " + document.body.innerText.slice(0, 400)',
    );
    console.error('Desktop page at failure:', page);
    throw new Error('terminal_not_rendered');
  }
  // A live pane is not proof: type into the shell and require the command's output back.
  const screenText = () =>
    window.webContents.executeJavaScript(
      "document.querySelector('.xterm-rows')?.textContent ?? ''",
    ) as Promise<string>;
  const promptDeadline = Date.now() + 25_000;
  while (Date.now() < promptDeadline && !(await screenText()).trim()) await sleep(200);
  if (!(await screenText()).trim()) throw new Error('terminal_no_output');
  await window.webContents.executeJavaScript(
    "document.querySelector('.xterm-helper-textarea')?.focus()",
  );
  const command =
    process.platform === 'win32' ? 'echo "davecode-pty-$(6*7)"' : 'echo davecode-pty-$((6*7))';
  await window.webContents.insertText(command);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  window.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  const echoDeadline = Date.now() + 15_000;
  while (Date.now() < echoDeadline && !(await screenText()).includes('davecode-pty-42'))
    await sleep(200);
  if (!(await screenText()).includes('davecode-pty-42')) {
    console.error('Terminal screen:', (await screenText()).slice(0, 400));
    throw new Error('terminal_input_failed');
  }
  await mkdir(output, { recursive: true });
  // The screenshot is evidence, not the check: headless Linux CI has no GPU to capture with.
  const image = await window.webContents.capturePage().catch(() => undefined);
  if (image) await writeFile(join(output, 'desktop.png'), image.toPNG());
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify({
      status: 'passed',
      version: '0.5.0',
      url: gateway,
      terminal: true,
      authenticated: true,
    }),
  );
}
