import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';

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
