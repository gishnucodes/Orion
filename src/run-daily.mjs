import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoRoot } from './config.mjs';

/**
 * @param {string} step        script name under src/
 * @param {boolean} [optional] when true, a failure is logged and the pipeline
 *                             continues. Delivery is optional: a mail-provider
 *                             outage should not mark the whole nightly run
 *                             failed, and unsent matches are retried tomorrow
 *                             because notify.mjs only records what it sent.
 */
function run(step, optional = false) {
  const script = path.join(repoRoot, 'src', `${step}.mjs`);
  // Load .env when present so a local `npm run run-daily` picks up the Resend
  // credentials the same way systemd's EnvironmentFile does on the server.
  const result = spawnSync('node', ['--env-file-if-exists=.env', script], {
    stdio: 'inherit',
    cwd: repoRoot
  });
  if (result.status !== 0) {
    if (optional) {
      console.error(`[run-daily] step "${step}" failed (status ${result.status}); continuing`);
      return false;
    }
    process.exit(result.status ?? 1);
  }
  return true;
}

run('scan');
run('extract');
run('score');
run('report');
run('export-bq', true);
run('notify', true);
