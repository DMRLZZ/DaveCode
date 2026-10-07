import { resolve } from 'node:path';
import { loadConfig, VERSION } from '@davecode/core';
import { findGateway, GatewayClient } from '../client';
import type { CliContext } from '../context';
import { CliError, EXIT } from '../errors';
import { detectProjectRoot, type Runtime, startRuntime } from '../runtime';
import { type ChatBackend, httpBackend } from '../tui/backend';

export interface ChatOptions {
  model?: string;
  project?: string;
}

/**
 * Open the chat TUI against the running gateway, or start an in-process gateway on an ephemeral
 * loopback port when none is running (it stops when the TUI exits).
 */
export async function chatCommand(ctx: CliContext, opts: ChatOptions): Promise<number> {
  if (!ctx.io.stdin.isTTY || !ctx.io.stdout.isTTY) {
    throw new CliError('The chat TUI needs an interactive terminal', {
      hint: 'For scripts, call the OpenAI-compatible API: POST http://127.0.0.1:4040/v1/chat/completions',
    });
  }
  const projectRoot = opts.project
    ? resolve(ctx.cwd, opts.project)
    : await detectProjectRoot(ctx.cwd, ctx.home);
  const config = loadConfig({
    home: ctx.home,
    env: ctx.env,
    ...(projectRoot ? { projectRoot } : {}),
  });

  let runtime: Runtime | undefined;
  let backend: ChatBackend;
  const running = await findGateway(config);
  if (running) {
    backend = httpBackend(running.client, false);
  } else {
    runtime = await startRuntime({
      home: ctx.home,
      env: ctx.env,
      cwd: ctx.cwd,
      host: '127.0.0.1',
      port: 0,
      dashboard: false,
      ...(projectRoot ? { projectDir: projectRoot } : { noProject: true }),
    });
    const target = config.server.authToken
      ? { baseUrl: runtime.url, token: config.server.authToken }
      : { baseUrl: runtime.url };
    backend = httpBackend(new GatewayClient(target), true);
  }

  try {
    const [{ render }, { createElement }, { ChatApp }] = await Promise.all([
      import('ink'),
      import('react'),
      import('../tui/ChatApp'),
    ]);
    const instance = render(
      createElement(ChatApp, {
        backend,
        theme: ctx.theme,
        model: opts.model ?? `davecode/${config.routing.defaultRoute}`,
        version: VERSION,
      }),
      {
        stdout: ctx.io.stdout as NodeJS.WriteStream,
        stdin: process.stdin,
        exitOnCtrlC: false,
        kittyKeyboard: { mode: 'auto', flags: ['disambiguateEscapeCodes'] },
      },
    );
    await instance.waitUntilExit();
  } finally {
    await runtime?.close();
  }
  return EXIT.ok;
}
