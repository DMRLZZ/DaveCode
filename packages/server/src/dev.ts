import { fileURLToPath } from 'node:url';
import {
  type AutonomousRunner,
  createEngine,
  createGoalService,
  createRunner,
  type GoalService,
  ProjectBrain,
  ProjectBrainSource,
  WorkspaceLock,
} from '@davecode/core';
import { startGateway } from './gateway';
import type { BrainSource } from './options';

// `pnpm dev`: run the gateway against ~/.davecode (or DAVECODE_HOME) and the invoking repo.
const cwd = process.env.INIT_CWD ?? process.cwd();
const engine = createEngine({ projectRoot: cwd });

// When the invoking directory belongs to a DaveCode project, expose its brain, runner and goal
// mode. The runner only starts when asked (`POST /api/runner/start`); runner and goals share one
// workspace lock so they never edit the working tree at the same time.
let brain: BrainSource | undefined;
let runner: AutonomousRunner | undefined;
let goals: GoalService | undefined;
const project = await ProjectBrain.find(cwd, { events: engine.events });
if (project && (await project.isInitialised())) {
  const lock = new WorkspaceLock();
  brain = new ProjectBrainSource(project);
  const budgetContext = () => engine.budget.context();
  runner = createRunner(engine, {
    brain: project,
    lock: { lock, owner: 'runner' },
    contextExtras: budgetContext,
  });
  goals = createGoalService(engine, { brain: project, lock, budgetContext });
}

const app = await startGateway(engine, {
  logger: { level: engine.config.logLevel },
  dashboardDir: fileURLToPath(new URL('../../ui/dist', import.meta.url)),
  ...(brain ? { brain } : {}),
  ...(runner ? { runner } : {}),
  ...(goals ? { goals } : {}),
});
if (project && runner) app.log.info(`project brain: ${project.root}`);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  const active = goals?.activeGoalId;
  if (active) await goals?.cancel(active);
  await runner?.stop();
  await app.close();
  engine.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
