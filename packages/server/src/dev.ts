import { fileURLToPath } from 'node:url';
import { createEngine } from '@davecode/core';
import { startGateway } from './gateway';

// `pnpm dev`: run the gateway against ~/.davecode (or DAVECODE_HOME) and the invoking repo.
const engine = createEngine({ projectRoot: process.env.INIT_CWD ?? process.cwd() });
const app = await startGateway(engine, {
  logger: { level: engine.config.logLevel },
  dashboardDir: fileURLToPath(new URL('../../ui/dist', import.meta.url)),
});

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await app.close();
  engine.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
