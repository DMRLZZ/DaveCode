import { homedir } from 'node:os';
import { join } from 'node:path';

/** Root of the global user brain and runtime state. Override with DAVECODE_HOME. */
export function davecodeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DAVECODE_HOME ?? join(homedir(), '.davecode');
}

export interface GlobalPaths {
  home: string;
  config: string;
  database: string;
  /** Encryption master key for the keyring (created with 0600 permissions). */
  masterKey: string;
  brain: string;
  sandboxes: string;
  profiles: string;
  logs: string;
}

export function globalPaths(home = davecodeHome()): GlobalPaths {
  return {
    home,
    config: join(home, 'config.json'),
    database: join(home, 'state.db'),
    masterKey: join(home, 'master.key'),
    brain: join(home, 'brain'),
    sandboxes: join(home, 'sandboxes'),
    profiles: join(home, 'profiles'),
    logs: join(home, 'logs'),
  };
}

export interface ProjectPaths {
  root: string;
  dir: string;
  config: string;
  state: string;
  architecture: string;
  taskGraph: string;
}

/** Local project brain inside a repository (`<repo>/.davecode`). */
export function projectPaths(root: string): ProjectPaths {
  const dir = join(root, '.davecode');
  return {
    root,
    dir,
    config: join(dir, 'config.json'),
    state: join(dir, 'STATE.md'),
    architecture: join(dir, 'ARCHITECTURE.md'),
    taskGraph: join(dir, 'TASK_GRAPH.json'),
  };
}
