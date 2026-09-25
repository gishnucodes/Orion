/**
 * Persist single files (SQLite databases, the applicant memory) in Cloud
 * Storage. Used by the Cloud Run entrypoint (jobs.sqlite round-trip) and by the
 * local applier (reads a jobs.sqlite snapshot, owns applications.sqlite).
 *
 * Authentication is Application Default Credentials: the job's service account
 * on Cloud Run, `gcloud auth application-default login` locally.
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { Storage } from '@google-cloud/storage';

let storage;
const client = () => (storage ??= new Storage());

/**
 * Download gs://bucket/object to dest. Returns the object's generation (for a
 * later conditional push), or null when the object does not exist yet.
 */
export async function pull(bucket, object, dest, log = () => {}) {
  mkdirSync(path.dirname(dest), { recursive: true });
  const file = client().bucket(bucket).file(object);
  const [exists] = await file.exists();
  if (!exists) {
    log(`gs://${bucket}/${object} not found — starting without it`);
    return null;
  }
  const [meta] = await file.getMetadata();
  await file.download({ destination: dest });
  log(`downloaded gs://${bucket}/${object} -> ${dest} (${statSync(dest).size} bytes)`);
  return String(meta.generation);
}

/**
 * Upload src to gs://bucket/object. With `ifGenerationMatch` the write only
 * succeeds if nobody else has written the object since it was pulled (use '0'
 * for "must not exist yet"); a lost race throws an error with code 412, which
 * callers handle by re-pulling and merging. Returns the new generation.
 */
export async function push(bucket, object, src, { ifGenerationMatch, log = () => {} } = {}) {
  if (!existsSync(src)) {
    log(`no file at ${src} to upload — skipping`);
    return null;
  }
  const options = { destination: object };
  if (ifGenerationMatch !== undefined && ifGenerationMatch !== null) {
    options.preconditionOpts = { ifGenerationMatch: Number(ifGenerationMatch) };
  }
  const [file] = await client().bucket(bucket).upload(src, options);
  log(`uploaded ${src} -> gs://${bucket}/${object} (${statSync(src).size} bytes)`);
  return String(file.metadata?.generation ?? '');
}

export const isPreconditionFailure = (err) => err?.code === 412 || /precondition/i.test(err?.message || '');
