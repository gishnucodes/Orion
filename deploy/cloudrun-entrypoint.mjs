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
 * Raw page text and the rendered report are deliberately NOT persisted: extract
 * re-fetches any page whose cached file is missing, and notify emails the report
 * then records what it sent, so neither needs to outlive the container.
 *
 * Authentication uses the job's service account via Application Default
 * Credentials — no key material in the image. The API keys the pipeline itself
 * needs (GEMINI_API_KEY, GOOGLE_SEARCH_*) arrive as env vars from Secret Manager.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { Storage } from '@google-cloud/storage';
import { loadConfig, repoRoot } from '../src/config.mjs';

const bucketName = process.env.GCS_BUCKET;
const objectName = process.env.GCS_DB_OBJECT || 'jobs.sqlite';

function log(msg) {
  console.log(`[cloudrun] ${msg}`);
}

async function downloadDb(dbPath) {
  if (!bucketName) {
    log('GCS_BUCKET not set — running with an ephemeral database (no persistence)');
    return;
  }
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const file = new Storage().bucket(bucketName).file(objectName);
  const [exists] = await file.exists();
  if (!exists) {
    log(`gs://${bucketName}/${objectName} not found — first run, starting with an empty database`);
    return;
  }
  await file.download({ destination: dbPath });
  log(`downloaded gs://${bucketName}/${objectName} -> ${dbPath} (${statSync(dbPath).size} bytes)`);
}

async function uploadDb(dbPath) {
  if (!bucketName) return;
  if (!existsSync(dbPath)) {
    log(`no database at ${dbPath} to upload — skipping`);
    return;
  }
  await new Storage().bucket(bucketName).upload(dbPath, { destination: objectName });
  log(`uploaded ${dbPath} -> gs://${bucketName}/${objectName} (${statSync(dbPath).size} bytes)`);
}

async function main() {
  const { paths } = loadConfig();
  const dbPath = paths.db;

  await downloadDb(dbPath);

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
    await uploadDb(dbPath);
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
