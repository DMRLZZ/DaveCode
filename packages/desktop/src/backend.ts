import { ProjectBrain } from '@davecode/core';
import { launchLoginTerminal, type Runtime, startRuntime } from '@dmrlzz/davecode/runtime';
import { startSchema } from './policy';

let runtime: Runtime | undefined;
let started = false;
let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  await runtime?.close();
  process.exit(0);
}

process.on('message', (message) => {
  if (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'stop'
  ) {
    void stop();
    return;
  }
  if (started) return;
  const parsed = startSchema.safeParse(message);
  if (!parsed.success) {
    process.send?.({ type: 'error' });
    process.exitCode = 1;
    process.disconnect?.();
    return;
  }
  started = true;
  const input = parsed.data;
  void (async () => {
    await ProjectBrain.init(input.project);
    runtime = await startRuntime({
      home: input.home,
      cwd: input.project,
      projectDir: input.project,
      env: { ...process.env, DAVECODE_DASHBOARD_DIR: input.dashboard },
      host: '127.0.0.1',
      port: 0,
      config: { server: { host: '127.0.0.1', authToken: input.token, dashboard: true } },
      loginLauncher: {
        async launch(account) {
          // The bundled CLI owns the official vendor login flow. No shell or credentials
          // are passed from the renderer, and the Node runtime ships with the desktop app.
          return {
            launched: await launchLoginTerminal(account.id, {
              argv: [process.execPath, input.cli],
              env: { ...process.env, DAVECODE_HOME: input.home },
            }),
          };
        },
      },
    });
    process.send?.({ type: 'ready', url: runtime.url });
  })().catch(async () => {
    // Provider/config failures may contain secrets. Keep IPC and native error dialogs generic.
    process.send?.({ type: 'error' });
    await runtime?.close();
    process.exit(1);
  });
});
process.on('disconnect', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
