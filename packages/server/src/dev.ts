import { fileURLToPath } from 'node:url';
import {
  type AutonomousRunner,
  createEngine,
  createRunner,
  ProjectBrain,
  ProjectBrainSource,
} from '@davecode/core';
import { startGateway } from './gateway';
import type { BrainSource } from './options';

// `pnpm dev`: run the gateway against ~/.davecode (or DAVECODE_HOME) and the invoking repo.
const cwd = process.env.INIT_CWD ?? process.cwd();
const engine = createEngine({ projectRoot: cwd });

// When the invoking directory belongs to a DaveCode project, expose its brain and runner.
// The runner only starts when asked (`POST /api/runner/start`).
let brain: BrainSource | undefined;
let runner: AutonomousRunner | undefined;
const project = await ProjectBrain.find(cwd, { events: engine.events });
if (project && (await project.isInitialised())) {
  brain = new ProjectBrainSource(project);
  runner = createRunner(engine, { brain: project });
}

const app = await startGateway(engine, {
  logger: { level: engine.config.logLevel },
  dashboardDir: fileURLToPath(new URL('../../ui/dist', import.meta.url)),
  ...(brain ? { brain } : {}),
  ...(runner ? { runner } : {}),
});
if (project && runner) app.log.info(`project brain: ${project.root}`);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await runner?.stop();
  await app.close();
  engine.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
