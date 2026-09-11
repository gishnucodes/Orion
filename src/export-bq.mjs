/**
 * Mirror the pipeline results into BigQuery for analysis / Looker Studio.
 *
 * SQLite remains the operational store (dedup + incremental extraction).
 * This stage denormalizes one wide, analysis-friendly row per job — job facts,
 * the latest extraction, and the latest score — and reloads it into a single
 * BigQuery table with WRITE_TRUNCATE, so the table is always a clean snapshot
 * of the current database.
 *
 * Gated on BQ_DATASET: with it unset the stage is a no-op, so local runs and the
 * VM deployment are unaffected. On Cloud Run the project and credentials come
 * from the job's service account (ADC); locally, set GOOGLE_CLOUD_PROJECT.
 *
 * Env:
 *   BQ_DATASET   dataset id (e.g. "orion")            — required to run
 *   BQ_TABLE     table id (default "jobs")
 *   BQ_LOCATION  dataset location (default "US")
 *   GOOGLE_CLOUD_PROJECT   project id (auto on Cloud Run)
 */
import { writeFileSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BigQuery } from '@google-cloud/bigquery';
import { loadConfig } from './config.mjs';
import { openDb } from './db.mjs';
import { safeJsonParse } from './utils.mjs';
import { createLogger } from './logger.mjs';

const SCHEMA = [
  { name: 'job_id', type: 'INTEGER' },
  { name: 'url', type: 'STRING' },
  { name: 'company', type: 'STRING' },
  { name: 'title', type: 'STRING' },
  { name: 'location', type: 'STRING' },
  { name: 'source', type: 'STRING' },
  { name: 'first_seen', type: 'DATE' },
  { name: 'last_seen', type: 'DATE' },
  { name: 'extraction_status', type: 'STRING' },
  { name: 'model', type: 'STRING' },
  { name: 'remote', type: 'BOOLEAN' },
  { name: 'seniority', type: 'STRING' },
  { name: 'employment_type', type: 'STRING' },
  { name: 'work_authorization', type: 'STRING' },
  { name: 'skills', type: 'STRING', mode: 'REPEATED' },
  { name: 'required_skills', type: 'STRING', mode: 'REPEATED' },
  { name: 'tech_stack', type: 'STRING', mode: 'REPEATED' },
  { name: 'score', type: 'FLOAT' },
  { name: 'matched', type: 'BOOLEAN' },
  // Scoring v2 components (0-1) and ATS keyword gaps.
  { name: 'score_confidence', type: 'STRING' },
  { name: 'skills_score', type: 'FLOAT' },
  { name: 'keywords_score', type: 'FLOAT' },
  { name: 'title_score', type: 'FLOAT' },
  { name: 'keywords_body_score', type: 'FLOAT' },
  { name: 'semantic_score', type: 'FLOAT' },
  { name: 'entity_delta', type: 'FLOAT' },
  { name: 'seniority_level', type: 'STRING' },
  { name: 'years_min', type: 'FLOAT' },
  { name: 'gate', type: 'STRING' },
  { name: 'has_description', type: 'BOOLEAN' },
  { name: 'matched_keywords', type: 'STRING', mode: 'REPEATED' },
  { name: 'alias_keywords', type: 'STRING', mode: 'REPEATED' },
  { name: 'missing_keywords', type: 'STRING', mode: 'REPEATED' },
  { name: 'exported_at', type: 'TIMESTAMP' }
];

const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const dateOrNull = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

function toRow(r, exportedAt) {
  const ext = r.ext_json ? (safeJsonParse(r.ext_json) || {}) : {};
  const g = ext.entity_graph || {};
  const b = r.breakdown_json ? (safeJsonParse(r.breakdown_json) || {}) : {};
  return {
    job_id: r.id,
    url: r.url || null,
    company: r.company || null,
    title: r.title || null,
    location: r.location || null,
    source: r.source || null,
    first_seen: dateOrNull(r.first_seen),
    last_seen: dateOrNull(r.last_seen),
    extraction_status: r.ext_status || null,
    model: r.ext_model || null,
    remote: typeof ext.remote === 'boolean' ? ext.remote : null,
    seniority: ext.seniority ?? g.seniority ?? null,
    employment_type: g.employment_type ?? null,
    work_authorization: g.work_authorization ?? null,
    skills: arr(ext.skills),
    required_skills: arr(g.required_skills),
    tech_stack: arr(g.tech_stack),
    score: typeof r.score === 'number' ? r.score : null,
    matched: r.matched === null || r.matched === undefined ? null : Boolean(r.matched),
    score_confidence: b.confidence ?? null,
    skills_score: num(b.skills),
    keywords_score: num(b.keywords),
    title_score: num(b.title),
    keywords_body_score: num(b.keywords_body),
    semantic_score: num(b.semantic),
    entity_delta: num(b.delta),
    seniority_level: b.seniority ?? null,
    years_min: num(b.years_min),
    gate: b.gate ?? null,
    has_description: Boolean(r.has_description),
    matched_keywords: arr(b.matched_keywords),
    alias_keywords: arr(b.alias_keywords),
    missing_keywords: arr(b.missing_keywords),
    exported_at: exportedAt
  };
}

async function main() {
  const { config, paths } = loadConfig();
  const logger = createLogger(paths.outputDir, 'export-bq');

  const datasetId = process.env.BQ_DATASET;
  if (!datasetId) {
    logger.info('BQ_DATASET not set — skipping BigQuery export');
    return;
  }
  const tableId = process.env.BQ_TABLE || 'jobs';
  const location = process.env.BQ_LOCATION || 'US';

  const db = openDb(paths.db);
  const rows = db.prepare(`
    SELECT
      j.id, j.url, j.company, j.title, j.location, j.source, j.first_seen, j.last_seen,
      e.json AS ext_json, e.model AS ext_model, e.status AS ext_status,
      s.score AS score, s.matched AS matched, s.breakdown_json AS breakdown_json,
      (j.description IS NOT NULL AND length(j.description) >= 200) AS has_description
    FROM jobs j
    LEFT JOIN extractions e ON e.id = (SELECT MAX(id) FROM extractions WHERE job_id = j.id)
    LEFT JOIN scores s ON s.id = (SELECT MAX(id) FROM scores WHERE job_id = j.id)
    ORDER BY j.id ASC
  `).all();

  logger.info(`Exporting ${rows.length} jobs to BigQuery ${datasetId}.${tableId}`);
  if (rows.length === 0) {
    logger.info('Nothing to export');
    return;
  }

  const exportedAt = new Date().toISOString();
  const ndjson = rows.map((r) => JSON.stringify(toRow(r, exportedAt))).join('\n');
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'orion-bq-'));
  const tmpFile = path.join(tmpDir, 'jobs.ndjson');
  writeFileSync(tmpFile, ndjson);

  const bq = new BigQuery({ location });
  const dataset = bq.dataset(datasetId);
  const [dsExists] = await dataset.exists();
  if (!dsExists) {
    logger.info(`Creating dataset ${datasetId} (${location})`);
    await dataset.create({ location });
  }

  const table = dataset.table(tableId);
  // WRITE_TRUNCATE: replace the table contents with this snapshot each run.
  const [job] = await table.load(tmpFile, {
    sourceFormat: 'NEWLINE_DELIMITED_JSON',
    schema: { fields: SCHEMA },
    writeDisposition: 'WRITE_TRUNCATE',
    location
  });
  const errors = job.status?.errors;
  if (errors && errors.length) {
    throw new Error(`BigQuery load errors: ${JSON.stringify(errors).slice(0, 500)}`);
  }
  logger.info(`BigQuery load complete: ${datasetId}.${tableId} (${rows.length} rows)`);
}

main().catch((err) => {
  console.error('[export-bq]', err?.message || err);
  process.exit(1);
});
