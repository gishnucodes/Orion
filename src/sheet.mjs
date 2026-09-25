import { GoogleAuth } from 'google-auth-library';
import { loadConfig } from './config.mjs';
import { openDb } from './db.mjs';
import { nowIsoDate } from './utils.mjs';
import { createLogger } from './logger.mjs';

/**
 * Append daily picks to the tracking Google Sheet — today's, plus any recent
 * day a failed run left out.
 *
 * The sheet is the working surface: you open the link, apply, and set Status.
 * BigQuery reads the same sheet as an external table (orion.picks_tracker), so
 * the marks are queryable next to orion.jobs and orion.daily_picks without an
 * export step. The sheet must be shared with the job's service account.
 *
 * Column order is a contract with that external table — append new columns at
 * the end, never reorder.
 */
export const HEADER = [
  'pick_date', 'rank', 'score', 'title', 'company', 'location', 'url',
  'matched_skills', 'job_id', 'status', 'notes'
];
// Offered by the Status dropdown. "Not available" (posting closed) and
// "Ineligible" (e.g. citizenship required) are the two you had to type by hand
// before the dropdown worked. Free text is still accepted; src/tracker.mjs
// normalises it.
export const STATUSES = ['Applied', 'Skipped', 'Interview', 'Rejected', 'Offer', 'Not available', 'Ineligible'];

const PICK_SELECT = `
    SELECT p.pick_date, p.rank, p.score, j.id AS job_id, j.title, j.company, j.location, j.url,
           s.breakdown_json
    FROM daily_picks p
    JOIN jobs j ON j.id = p.job_id
    LEFT JOIN scores s ON s.id = (SELECT MAX(id) FROM scores WHERE job_id = j.id)`;

function toSheetRow(r) {
  let matched = [];
  try {
    const b = JSON.parse(r.breakdown_json || '{}');
    matched = [...(b.skills_detail?.matched_required || []), ...(b.matched_keywords || [])];
  } catch { /* unscored row: leave the column empty */ }
  return [
    r.pick_date, r.rank, r.score, clean(r.title), r.company || '', clean(r.location),
    r.url, [...new Set(matched)].slice(0, 8).join(', '), r.job_id, '', ''
  ];
}

/** One day's picks as sheet rows, best first. Status and notes are left for you. */
export function pickRows(db, date) {
  return db.prepare(`${PICK_SELECT} WHERE p.pick_date = ? ORDER BY p.created_at ASC, p.rank ASC`).all(date).map(toSheetRow);
}

/** Every pick since `sinceDate`, oldest batch first and best first within a batch. */
export function recentPickRows(db, sinceDate) {
  return db.prepare(`${PICK_SELECT} WHERE p.pick_date >= ? ORDER BY p.created_at ASC, p.rank ASC`).all(sinceDate).map(toSheetRow);
}

/** Scraped titles can carry newlines and runs of spaces that break a cell. */
function clean(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

export const API = 'https://sheets.googleapis.com/v4/spreadsheets';

/** Authenticated Sheets caller: the job's service account on Cloud Run, your ADC locally. */
export async function sheetsClient(scopes = ['https://www.googleapis.com/auth/spreadsheets']) {
  const client = await new GoogleAuth({ scopes }).getClient();
  return async (url, method = 'GET', data) => (await client.request({ url, method, data })).data;
}

/**
 * Put the Status dropdown on every row below the header.
 *
 * Re-applied after each append. Applying it once at setup was the bug: the
 * dropdown sat on empty rows 2..1000, then appending *inserted* the picks above
 * them, so no pick row ever had one. Setting validation on a range that already
 * has it simply replaces it, so this is safe to repeat.
 */
async function applyStatusDropdown(call, sheetId, grid) {
  const statusCol = HEADER.indexOf('status');
  await call(`${API}/${sheetId}:batchUpdate`, 'POST', {
    requests: [{
      setDataValidation: {
        range: { sheetId: grid.sheetId, startRowIndex: 1, startColumnIndex: statusCol, endColumnIndex: statusCol + 1 },
        rule: {
          condition: { type: 'ONE_OF_LIST', values: STATUSES.map((v) => ({ userEnteredValue: v })) },
          showCustomUi: true,
          strict: false
        }
      }
    }]
  });
}

/**
 * Pick rows whose job is not in the sheet yet, in order.
 *
 * Keyed on job_id, not date: several runs can add batches on the same day (the
 * schedule plus any you trigger), and the sheet stage is optional, so a run it
 * failed on is caught up by the next one instead of lost.
 */
export function rowsNotInSheet(pickRowsList, sheetValues) {
  const col = HEADER.indexOf('job_id');
  const present = new Set((sheetValues || []).slice(1).map((r) => String(r[col] ?? '').trim()).filter(Boolean));
  return pickRowsList.filter((r) => !present.has(String(r[col])));
}

/**
 * Make the tab ready: create it if missing, and on an empty tab write the
 * header and freeze it. Returns the tab's rows (header first) and its grid properties.
 */
async function ensureSheet(call, sheetId, tab, logger) {
  const range = (r) => encodeURIComponent(`'${tab}'!${r}`);
  const meta = await call(`${API}/${sheetId}?fields=properties.title,sheets.properties`);
  let grid = meta.sheets?.find((s) => s.properties.title === tab)?.properties;
  if (!grid) {
    const res = await call(`${API}/${sheetId}:batchUpdate`, 'POST', { requests: [{ addSheet: { properties: { title: tab } } }] });
    grid = res.replies[0].addSheet.properties;
    logger.info(`Created tab "${tab}"`);
  }
  let values = (await call(`${API}/${sheetId}/values/${range('A:K')}`)).values || [];
  if (values.length === 0) {
    await call(`${API}/${sheetId}/values/${range('A1')}?valueInputOption=RAW`, 'PUT', { values: [HEADER] });
    await call(`${API}/${sheetId}:batchUpdate`, 'POST', {
      requests: [{ updateSheetProperties: { properties: { sheetId: grid.sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } }]
    });
    logger.info(`Wrote header to "${tab}"`);
    values = [HEADER];
  }
  return { title: meta.properties?.title, values, grid };
}

async function main() {
  const { config, paths } = loadConfig();
  const logger = createLogger(paths.outputDir, 'sheet');
  // --check: prove the job's credentials can open the sheet and set it up,
  // without appending anything. Run it as the job itself:
  //   gcloud run jobs execute orion --args=node,src/sheet.mjs,--check --wait
  const checkOnly = process.argv.includes('--check');
  const sheetId = process.env.SHEET_ID || config.sheet?.id;
  if (!sheetId) {
    logger.info('No SHEET_ID configured — skipping the tracking sheet');
    return;
  }
  const tab = config.sheet?.tab || 'Picks';

  const call = await sheetsClient();
  const range = (r) => encodeURIComponent(`'${tab}'!${r}`);

  const { title, values, grid } = await ensureSheet(call, sheetId, tab, logger);
  if (checkOnly) {
    // Also repairs the dropdown on rows appended before it was re-applied.
    await applyStatusDropdown(call, sheetId, grid);
    logger.info(`Sheet "${title}" is reachable; tab "${tab}" ready with ${Math.max(0, values.length - 1)} data rows; Status dropdown applied`);
    return;
  }

  // Every recent pick not in the sheet yet: this run's batch, plus any a
  // failed earlier run left behind.
  const backfillDays = config.sheet?.backfill_days ?? 7;
  const since = new Date(Date.now() - backfillDays * 86400000).toISOString().slice(0, 10);
  const db = openDb(paths.db);
  const rows = rowsNotInSheet(recentPickRows(db, since), values);
  if (!rows.length) {
    logger.info(`Sheet is up to date through ${nowIsoDate()}; nothing to append`);
    return;
  }
  await call(
    `${API}/${sheetId}/values/${range('A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    'POST',
    { values: rows }
  );
  await applyStatusDropdown(call, sheetId, grid);
  logger.info(`Appended ${rows.length} picks to "${tab}"`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[sheet]', err?.response?.data?.error?.message || err?.message || err);
    process.exit(1);
  });
}
