/**
 * applications.sqlite — the applier's own state. Deliberately a separate file
 * from jobs.sqlite: the nightly Cloud Run job rewrites jobs.sqlite at 6 PM ET,
 * and keeping the applier's writes out of it means the two never race. The
 * pipeline only reads this file (attachApplications in src/db.mjs).
 *
 * status lifecycle:
 *   filling      the agent is working on the form
 *   needs_human  paused and left unresolved (window closed, Ctrl-C, error mid-pause)
 *   ready        filled and gated, not submitted (shadow mode or review-skip)
 *   submitted    confirmation seen (or you confirmed a manual submit)
 *   skipped      you chose to skip it — never re-queued
 *   failed       the agent could not complete it — re-queued with --retry-failed
 */
import Database from 'better-sqlite3';

export const STATUSES = ['filling', 'needs_human', 'ready', 'submitted', 'skipped', 'failed'];

export function openStore(dbPath) {
  const db = new Database(dbPath);
  // DELETE journal mode (not WAL): the file is uploaded to GCS as a single
  // object, and WAL would leave committed rows behind in a -wal sidecar.
  db.pragma('journal_mode = DELETE');
  db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      job_id INTEGER PRIMARY KEY,
      url TEXT,
      company TEXT,
      title TEXT,
      ats TEXT,
      engine TEXT,
      status TEXT NOT NULL,
      answers_json TEXT,
      missing_json TEXT,
      gate_json TEXT,
      error TEXT,
      screenshot_path TEXT,
      submitted_at TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

const COLUMNS = ['url', 'company', 'title', 'ats', 'engine', 'status', 'answers_json', 'missing_json',
  'gate_json', 'error', 'screenshot_path', 'submitted_at'];

/** Insert or merge fields into a job's row. Objects are JSON-encoded. */
export function saveApplication(db, jobId, fields) {
  const now = new Date().toISOString();
  const row = { job_id: jobId, updated_at: now };
  for (const col of COLUMNS) {
    if (!(col in fields)) continue;
    const v = fields[col];
    row[col] = v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
  }
  if (row.status && !STATUSES.includes(row.status)) throw new Error(`bad application status: ${row.status}`);
  const cols = Object.keys(row);
  const existing = db.prepare('SELECT 1 FROM applications WHERE job_id = ?').get(jobId);
  if (existing) {
    const sets = cols.filter((c) => c !== 'job_id').map((c) => `${c} = @${c}`).join(', ');
    db.prepare(`UPDATE applications SET ${sets} WHERE job_id = @job_id`).run(row);
  } else {
    if (!row.status) row.status = 'filling';
    const names = Object.keys(row);
    db.prepare(`INSERT INTO applications (${names.join(', ')}) VALUES (${names.map((c) => `@${c}`).join(', ')})`).run(row);
  }
}

export function getApplication(db, jobId) {
  return db.prepare('SELECT * FROM applications WHERE job_id = ?').get(jobId) || null;
}

/** Job ids that must not be queued again. */
export function handledJobIds(db, { retryFailed = false } = {}) {
  const statuses = retryFailed ? ['submitted', 'skipped'] : ['submitted', 'skipped', 'failed'];
  return new Set(db.prepare(`SELECT job_id FROM applications WHERE status IN (${statuses.map(() => '?').join(',')})`)
    .all(...statuses).map((r) => r.job_id));
}

/** Submissions today (local date), for the daily auto-submit cap. */
export function submittedToday(db, now = new Date()) {
  const day = localDate(now);
  return db.prepare('SELECT submitted_at FROM applications WHERE status = ?').all('submitted')
    .filter((r) => r.submitted_at && localDate(new Date(r.submitted_at)) === day).length;
}

function localDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Merge rows from another copy of the store (the remote one, after a lost GCS
 * race) into `db`: for each job keep whichever row was updated last.
 */
export function mergeFrom(db, otherPath) {
  const other = new Database(otherPath, { readonly: true });
  try {
    const rows = other.prepare('SELECT * FROM applications').all();
    const getMine = db.prepare('SELECT updated_at FROM applications WHERE job_id = ?');
    const cols = ['job_id', ...COLUMNS, 'updated_at'];
    const upsert = db.prepare(`INSERT OR REPLACE INTO applications (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`);
    let merged = 0;
    db.transaction(() => {
      for (const r of rows) {
        const mine = getMine.get(r.job_id);
        if (!mine || (r.updated_at || '') > (mine.updated_at || '')) {
          upsert.run(Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
          merged += 1;
        }
      }
    })();
    return merged;
  } finally {
    other.close();
  }
}
