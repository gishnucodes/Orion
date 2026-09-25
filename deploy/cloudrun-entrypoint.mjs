/**
 * Cloud Run Job entrypoint.
 *
 * Cloud Run execution environments are ephemeral, but Orion's incremental model
 * depends on jobs.sqlite surviving between nightly runs (scan dedups against it,
 * and extract only processes rows with no successful extraction yet). So this
 * wrapper persists exactly that one file in Cloud Storage:
 *
 *   1. download gs://$GCS_BUCKET/$GCS_DB_OBJECT -> paths.db   (skip on first run)
 *   2. run the normal pipeline (src/run-daily.mjs)
 *   3. upload paths.db -> gs://$GCS_BUCKET/$GCS_DB_OBJECT      (always, so a
 *      failed notify/report step does not lose the scan+extract work)
 *
 * It also pulls applications.sqlite (written only by the local applier) so
 * export-bq and notify can see which jobs have been applied to.
 *
 * Raw page text and the rendered report are deliberately NOT persisted: extract
 * re-fetches any page whose cached file is missing, and notify emails the report
 * then records what it sent, so neither needs to outlive the container.
 *
 * Authentication uses the job's service account via Application Default
 * Credentials — no key material in the image. The API keys the pipeline itself
 * needs (GEMINI_API_KEY, GOOGLE_SEARCH_*) arrive as env vars from Secret Manager.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pull, push } from '../src/gcs-sync.mjs';
import { loadConfig, repoRoot } from '../src/config.mjs';

const bucketName = process.env.GCS_BUCKET;
const objectName = process.env.GCS_DB_OBJECT || 'jobs.sqlite';
const applicationsObject = process.env.GCS_APPLICATIONS_OBJECT || 'applications.sqlite';

function log(msg) {
  console.log(`[cloudrun] ${msg}`);
}

async function main() {
  const { paths } = loadConfig();
  const dbPath = paths.db;

  if (bucketName) {
    await pull(bucketName, objectName, dbPath, log);
    // Read-only copy of the local applier's state, so export-bq can report
    // application status and notify can skip jobs already applied to. Never
    // uploaded from here: the applier is the only writer.
    await pull(bucketName, applicationsObject, paths.applicationsDb, log).catch((err) => {
      log(`applications db not pulled: ${err?.message || err}`);
    });
  } else {
    log('GCS_BUCKET not set — running with an ephemeral database (no persistence)');
  }

  // run-daily loads .env itself; in Cloud Run the variables are already in the
  // environment, so --env-file-if-exists is simply a no-op there.
  log('starting pipeline (run-daily)');
  const result = spawnSync('node', [path.join(repoRoot, 'src', 'run-daily.mjs')], {
    stdio: 'inherit',
    cwd: repoRoot,
    env: process.env
  });
  const status = result.status ?? 1;
  log(`pipeline exited with status ${status}`);

  // Persist the database regardless of pipeline status so a late-stage failure
  // (e.g. email delivery) never discards the scan/extract work.
  try {
    if (bucketName) await push(bucketName, objectName, dbPath, { log });
  } catch (err) {
    console.error(`[cloudrun] database upload failed: ${err?.message || err}`);
    process.exit(status || 1);
  }

  process.exit(status);
}

main().catch((err) => {
  console.error('[cloudrun] fatal:', err);
  process.exit(1);
});
