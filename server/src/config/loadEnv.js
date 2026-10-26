// Loads the project-root .env (if present) for local entry points: the dev
// server and the CLI scripts. Done in code rather than with Node's
// --env-file-if-exists flag, because combining that flag with --watch crashes
// when .env does not exist. Variables already set in the shell win.
// Vercel injects its variables directly, so api/index.js does not import this.
import { fileURLToPath } from 'node:url';

const envPath = fileURLToPath(new URL('../../../.env', import.meta.url));
try {
  process.loadEnvFile(envPath);
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
