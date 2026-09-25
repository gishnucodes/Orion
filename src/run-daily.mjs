import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoRoot, loadConfig } from './config.mjs';

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

const { config } = loadConfig();

run('scan');
run('extract');
run('score');
// Today's top picks by score (src/pick.mjs) — the list the tracking sheet shows.
run('pick');
run('report');
// Delivery is optional: an outage there must not fail the run or lose picks.
// They stay in daily_picks, and sheet.mjs appends every recent date the sheet
// is missing (datesToAppend), so the next successful run catches up.
run('sheet', true);
run('export-bq', true);
if (config.notify?.enabled !== false) run('notify', true);
