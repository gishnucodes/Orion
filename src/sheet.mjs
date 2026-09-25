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
export const STATUSES = ['Applied', 'Skipped', 'Interview', 'Rejected', 'Offer'];

/** One day's picks as sheet rows, best first. Status and notes are left for you. */
export function pickRows(db, date) {
  const rows = db.prepare(`
    SELECT p.pick_date, p.rank, p.score, j.id AS job_id, j.title, j.company, j.location, j.url,
           s.breakdown_json
    FROM daily_picks p
    JOIN jobs j ON j.id = p.job_id
    LEFT JOIN scores s ON s.id = (SELECT MAX(id) FROM scores WHERE job_id = j.id)
    WHERE p.pick_date = ?
    ORDER BY p.rank ASC
  `).all(date);
  return rows.map((r) => {
    let matched = [];
    try {
      const b = JSON.parse(r.breakdown_json || '{}');
      matched = [...(b.skills_detail?.matched_required || []), ...(b.matched_keywords || [])];
    } catch { /* unscored row: leave the column empty */ }
    return [
      r.pick_date, r.rank, r.score, clean(r.title), r.company || '', clean(r.location),
      r.url, [...new Set(matched)].slice(0, 8).join(', '), r.job_id, '', ''
    ];
  });
}

/** Scraped titles can carry newlines and runs of spaces that break a cell. */
function clean(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

const API = 'https://sheets.googleapis.com/v4/spreadsheets';

/**
 * Pick dates stored locally but missing from the sheet, oldest first.
 *
 * The sheet stage is optional in run-daily, so it can fail on a given night
 * (an outage, a revoked share). Appending every missing date rather than only
 * today's means the next successful run catches up instead of losing a day.
 */
export function datesToAppend(pickDates, sheetFirstColumn) {
  const present = new Set((sheetFirstColumn || []).map(([v]) => v));
  return [...new Set(pickDates)].filter((d) => !present.has(d)).sort();
}

/**
 * Make the tab ready: create it if missing, and on an empty tab write the
 * header, the Status dropdown and a frozen header row. Returns column A.
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
  let firstCol = (await call(`${API}/${sheetId}/values/${range('A:A')}`)).values || [];
  if (firstCol.length === 0) {
    await call(`${API}/${sheetId}/values/${range('A1')}?valueInputOption=RAW`, 'PUT', { values: [HEADER] });
    const statusCol = HEADER.indexOf('status');
    await call(`${API}/${sheetId}:batchUpdate`, 'POST', {
      requests: [
        {
          setDataValidation: {
            range: { sheetId: grid.sheetId, startRowIndex: 1, startColumnIndex: statusCol, endColumnIndex: statusCol + 1 },
            rule: {
              condition: { type: 'ONE_OF_LIST', values: STATUSES.map((v) => ({ userEnteredValue: v })) },
              showCustomUi: true,
              strict: false
            }
          }
        },
        { updateSheetProperties: { properties: { sheetId: grid.sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } }
      ]
    });
    logger.info(`Wrote header and Status dropdown to "${tab}"`);
    firstCol = [[HEADER[0]]];
  }
  return { title: meta.properties?.title, firstCol };
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

  // Service-account credentials on Cloud Run, your gcloud ADC locally.
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const client = await auth.getClient();
  const call = async (url, method = 'GET', data) => (await client.request({ url, method, data })).data;
  const range = (r) => encodeURIComponent(`'${tab}'!${r}`);

  const { title, firstCol } = await ensureSheet(call, sheetId, tab, logger);
  if (checkOnly) {
    logger.info(`Sheet "${title}" is reachable; tab "${tab}" ready with ${Math.max(0, firstCol.length - 1)} data rows`);
    return;
  }

  // Catch up on any recent day the sheet missed, not only today.
  const backfillDays = config.sheet?.backfill_days ?? 7;
  const since = new Date(Date.now() - backfillDays * 86400000).toISOString().slice(0, 10);
  const db = openDb(paths.db);
  const pickDates = db.prepare('SELECT DISTINCT pick_date FROM daily_picks WHERE pick_date >= ?').all(since).map((r) => r.pick_date);
  const missing = datesToAppend(pickDates, firstCol);
  if (!missing.length) {
    logger.info(`Sheet is up to date through ${nowIsoDate()}; nothing to append`);
    return;
  }
  const rows = missing.flatMap((d) => pickRows(db, d));
  await call(
    `${API}/${sheetId}/values/${range('A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    'POST',
    { values: rows }
  );
  logger.info(`Appended ${rows.length} picks for ${missing.join(', ')} to "${tab}"`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[sheet]', err?.response?.data?.error?.message || err?.message || err);
    process.exit(1);
  });
}
