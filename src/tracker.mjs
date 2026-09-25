import { loadConfig } from './config.mjs';
import { openDb } from './db.mjs';
import { createLogger } from './logger.mjs';
import { HEADER, API, sheetsClient } from './sheet.mjs';

/**
 * Mirror the Status and notes you set in the tracking sheet into the database.
 *
 * Without this the pipeline never learned what you did with a pick: the local
 * auto-applier could re-apply to a job you had already applied to by hand, and
 * orion.jobs.application_status stayed blank. Read-only on the sheet.
 */

/**
 * Canonical status for what was typed. Before the dropdown worked, statuses
 * were free text ("applied", "not available", "US Citizen"); anything
 * unrecognised is kept as "Other" with the original text alongside.
 */
export function normalizeStatus(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/citizen|clearance|itar|ineligib|not eligible|visa|sponsor/.test(s)) return 'Ineligible';
  if (/not available|unavailable|closed|filled|expired|no longer|removed|404|dead link/.test(s)) return 'Not available';
  if (/offer/.test(s)) return 'Offer';
  if (/reject|declin|turned down|no offer/.test(s)) return 'Rejected';
  if (/interview|screen|onsite|on-site|phone call/.test(s)) return 'Interview';
  if (/skip|pass|not interested|ignore|^no$/.test(s)) return 'Skipped';
  if (/appl|submitted|^done$|^yes$|^y$|✓|✅/.test(s)) return 'Applied';
  return 'Other';
}

/**
 * Make tracker_status match the sheet. `rows` are { job_id, raw_status, notes,
 * pick_date } for every sheet row; a row whose status was cleared is removed.
 * `updated_at` only moves when the status or notes actually change.
 */
export function syncStatuses(db, rows, now = new Date().toISOString()) {
  const get = db.prepare('SELECT status, raw_status, notes FROM tracker_status WHERE job_id = ?');
  const insert = db.prepare(`INSERT INTO tracker_status (job_id, status, raw_status, notes, pick_date, first_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const update = db.prepare('UPDATE tracker_status SET status = ?, raw_status = ?, notes = ?, updated_at = ? WHERE job_id = ?');
  const remove = db.prepare('DELETE FROM tracker_status WHERE job_id = ?');
  const jobExists = db.prepare('SELECT 1 FROM jobs WHERE id = ?');
  const counts = { inserted: 0, updated: 0, cleared: 0, unchanged: 0, unknown_job: 0 };
  const byStatus = {};
  db.transaction(() => {
    for (const r of rows) {
      const id = Number(r.job_id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const status = normalizeStatus(r.raw_status);
      const notes = String(r.notes ?? '').trim() || null;
      const prev = get.get(id);
      if (!status && !notes) {
        if (prev) { remove.run(id); counts.cleared += 1; }
        continue;
      }
      // A note without a status is kept too; it records that you looked at it.
      const finalStatus = status ?? 'Other';
      byStatus[finalStatus] = (byStatus[finalStatus] ?? 0) + 1;
      const raw = String(r.raw_status ?? '').trim() || null;
      if (!prev) {
        if (!jobExists.get(id)) { counts.unknown_job += 1; continue; }
        insert.run(id, finalStatus, raw, notes, r.pick_date || null, now, now);
        counts.inserted += 1;
      } else if (prev.status !== finalStatus || prev.raw_status !== raw || prev.notes !== notes) {
        update.run(finalStatus, raw, notes, now, id);
        counts.updated += 1;
      } else {
        counts.unchanged += 1;
      }
    }
  })();
  return { ...counts, byStatus };
}

async function main() {
  const { config, paths } = loadConfig();
  const logger = createLogger(paths.outputDir, 'tracker');
  const sheetId = process.env.SHEET_ID || config.sheet?.id;
  if (!sheetId) {
    logger.info('No SHEET_ID configured — nothing to sync');
    return;
  }
  const tab = config.sheet?.tab || 'Picks';
  const call = await sheetsClient(['https://www.googleapis.com/auth/spreadsheets.readonly']);
  const values = (await call(`${API}/${sheetId}/values/${encodeURIComponent(`'${tab}'!A:Z`)}`)).values || [];
  if (values.length < 2) {
    logger.info(`Tab "${tab}" has no data rows yet`);
    return;
  }
  // Columns by header name, so a column you add or reorder by hand is harmless.
  const header = values[0].map((h) => String(h).trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const [ji, si, ni, di] = ['job_id', 'status', 'notes', 'pick_date'].map(col);
  if (ji < 0 || si < 0) throw new Error(`tab "${tab}" is missing job_id/status columns (expected header: ${HEADER.join(', ')})`);
  const rows = values.slice(1).map((r) => ({ job_id: r[ji], raw_status: r[si], notes: ni >= 0 ? r[ni] : null, pick_date: di >= 0 ? r[di] : null }));

  const db = openDb(paths.db);
  const result = syncStatuses(db, rows);
  logger.info(`Synced ${rows.length} sheet rows: ${JSON.stringify(result)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[tracker]', err?.response?.data?.error?.message || err?.message || err);
    process.exit(1);
  });
}
