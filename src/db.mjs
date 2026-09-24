import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { jobKey, JOB_KEY_VERSION } from './utils.mjs';

export function openDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      company TEXT,
      title TEXT,
      location TEXT,
      source TEXT,
      first_seen TEXT,
      last_seen TEXT,
      raw_path TEXT
    );
    CREATE TABLE IF NOT EXISTS extractions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      json TEXT,
      model TEXT,
      status TEXT,
      created_at TEXT,
      FOREIGN KEY(job_id) REFERENCES jobs(id)
    );
    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      score REAL NOT NULL,
      matched INTEGER NOT NULL,
      breakdown_json TEXT,
      created_at TEXT,
      FOREIGN KEY(job_id) REFERENCES jobs(id)
    );
    CREATE TABLE IF NOT EXISTS notified (
      job_id INTEGER PRIMARY KEY,
      notified_at TEXT,
      FOREIGN KEY(job_id) REFERENCES jobs(id)
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date TEXT NOT NULL,
      stage TEXT NOT NULL,
      counts_json TEXT,
      duration_ms INTEGER
    );
    -- Per-job semantic match, reused until the posting, CV or model changes.
    CREATE TABLE IF NOT EXISTS semantic_cache (
      job_id INTEGER PRIMARY KEY,
      text_hash TEXT NOT NULL,
      cv_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      sims_json TEXT NOT NULL,
      created_at TEXT,
      FOREIGN KEY(job_id) REFERENCES jobs(id)
    );
  `);
  // Posting text, persisted so keyword and semantic scoring survive the
  // ephemeral Cloud Run filesystem (raw/ files do not).
  const jobColumns = db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
  if (!jobColumns.includes('description')) db.exec('ALTER TABLE jobs ADD COLUMN description TEXT');
  // Dedup key across sources (see canonicalUrl). Backfilled once for rows that
  // predate the column, so the first aggregator run does not re-insert them.
  if (!jobColumns.includes('url_key')) db.exec('ALTER TABLE jobs ADD COLUMN url_key TEXT');
  db.exec('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT)');
  const keyVersion = db.prepare("SELECT value FROM schema_meta WHERE key = 'job_key_version'").get()?.value;
  const setKey = db.prepare('UPDATE jobs SET url_key = ? WHERE id = ?');
  // A rule change (JOB_KEY_VERSION) re-keys every row; otherwise only rows
  // written before the column existed.
  const stale = String(keyVersion) === String(JOB_KEY_VERSION)
    ? db.prepare('SELECT id, url FROM jobs WHERE url_key IS NULL').all()
    : db.prepare('SELECT id, url FROM jobs').all();
  if (stale.length) {
    db.transaction((rows) => { for (const r of rows) setKey.run(jobKey(r.url), r.id); })(stale);
  }
  db.prepare("INSERT INTO schema_meta (key, value) VALUES ('job_key_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(JOB_KEY_VERSION));
  db.exec('CREATE INDEX IF NOT EXISTS jobs_url_key ON jobs(url_key)');
  // One row per job per day it was picked for the tracking sheet (src/pick.mjs).
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_picks (
      pick_date TEXT NOT NULL,
      job_id INTEGER NOT NULL,
      rank INTEGER NOT NULL,
      score REAL NOT NULL,
      PRIMARY KEY (pick_date, job_id),
      FOREIGN KEY(job_id) REFERENCES jobs(id)
    );
    CREATE INDEX IF NOT EXISTS daily_picks_job ON daily_picks(job_id);
  `);
  return db;
}

/**
 * Attach the applier's database (src/apply/store.mjs owns its schema) as schema
 * `apps`, so pipeline queries can read `apps.applications` (job_id, status).
 * When the file does not exist — no applications yet, or a local run without
 * it — an empty in-memory stand-in keeps those queries valid.
 */
export function attachApplications(db, applicationsDbPath) {
  if (applicationsDbPath && existsSync(applicationsDbPath)) {
    db.prepare('ATTACH DATABASE ? AS apps').run(applicationsDbPath);
    const hasTable = db.prepare("SELECT 1 FROM apps.sqlite_master WHERE type = 'table' AND name = 'applications'").get();
    if (hasTable) return true;
    db.exec('DETACH DATABASE apps');
  }
  db.exec("ATTACH DATABASE ':memory:' AS apps; CREATE TABLE apps.applications (job_id INTEGER PRIMARY KEY, status TEXT)");
  return false;
}
