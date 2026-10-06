import { runCli } from './program';

const code = await runCli(process.argv.slice(2), {
  io: { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin },
  env: process.env,
  cwd: process.cwd(),
});
process.exitCode = code;
