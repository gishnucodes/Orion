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
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date TEXT NOT NULL,
      stage TEXT NOT NULL,
      counts_json TEXT,
      duration_ms INTEGER
    );
  `);
  return db;
}
