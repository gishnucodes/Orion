import { loadConfig } from './config.mjs';
import { openDb, attachApplications } from './db.mjs';
import { nowIsoDate } from './utils.mjs';
import { createLogger } from './logger.mjs';
import { resolveScoringConfig } from './scoring/formula.mjs';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'Orion <onboarding@resend.dev>';

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Scores are stored 0-100 and shown out of 10.
const display = (score) => (score / 10).toFixed(1);

function scoreColor(score) {
  if (score >= 75) return '#0f7b45';
  if (score >= 60) return '#1a6ec4';
  return '#6b6b6b';
}

/**
 * Table-based layout with inline styles — the only thing that renders
 * consistently across Gmail, Outlook and Apple Mail. No external assets, so
 * nothing breaks when a client blocks remote content.
 */
function renderHtml(jobs, { threshold, date }) {
  const rows = jobs.map((job) => {
    const reasons = (job.reasons || []).filter((r) => r !== 'Matched');
    return `
      <tr>
        <td style="padding:14px 16px;border-bottom:1px solid #e6e6e6;">
          <div style="font:600 15px/1.4 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
            <a href="${escapeHtml(job.url)}" style="color:#1a1a1a;text-decoration:none;">${escapeHtml(job.title || 'Untitled')}</a>
          </div>
          <div style="font:400 13px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#666;margin-top:3px;">
            ${escapeHtml(job.company || 'Unknown')}
            ${reasons.length ? ` &middot; <span style="color:#999;">${escapeHtml(reasons.join('; '))}</span>` : ''}
          </div>
          <div style="margin-top:8px;">
            <a href="${escapeHtml(job.url)}" style="font:600 12px/1 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a6ec4;text-decoration:none;">Apply &rarr;</a>
          </div>
        </td>
        <td style="padding:14px 16px;border-bottom:1px solid #e6e6e6;text-align:right;vertical-align:top;white-space:nowrap;">
          <span style="display:inline-block;font:700 13px/1 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#fff;background:${scoreColor(job.score)};border-radius:11px;padding:5px 10px;">${display(job.score)}</span>
        </td>
      </tr>`;
  }).join('');

  return `<!doctype html>
<html><body style="margin:0;padding:24px 12px;background:#f5f5f5;">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;width:100%;background:#fff;border-radius:10px;border:1px solid #e0e0e0;">
    <tr>
      <td style="padding:20px 16px 14px;border-bottom:2px solid #1a1a1a;">
        <div style="font:700 18px/1.3 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;">
          ${jobs.length} new match${jobs.length === 1 ? '' : 'es'}
        </div>
        <div style="font:400 13px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#777;margin-top:3px;">
          Orion &middot; ${escapeHtml(date)} &middot; threshold ${escapeHtml(String(threshold))}
        </div>
      </td>
    </tr>
    ${rows}
    <tr>
      <td colspan="2" style="padding:14px 16px;font:400 12px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#999;">
        Each job is sent once. Raise <code>scoring_v2.threshold</code> or lower <code>daily_top_n</code> in config.yml to receive fewer.
      </td>
    </tr>
  </table>
</body></html>`;
}

function renderText(jobs, { threshold, date }) {
  const lines = [`Orion — ${jobs.length} new match${jobs.length === 1 ? '' : 'es'} (${date}, threshold ${threshold})`, ''];
  for (const job of jobs) {
    lines.push(`${display(job.score)}  ${job.company || 'Unknown'} — ${job.title || 'Untitled'}`);
    lines.push(`     ${job.url}`);
    const reasons = (job.reasons || []).filter((r) => r !== 'Matched');
    if (reasons.length) lines.push(`     (${reasons.join('; ')})`);
    lines.push('');
  }
  return lines.join('\n');
}

async function sendEmail({ apiKey, from, to, subject, html, text }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
      signal: controller.signal
    });
    const body = await res.text();
    if (!res.ok) {
      // Resend returns a JSON error with a useful `message`; surface it rather
      // than a bare status, since the common failures (unverified domain,
      // wrong recipient for the shared sender) are all diagnosable from it.
      throw new Error(`resend ${res.status}: ${body}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const { paths, config } = loadConfig();
  const scoring = resolveScoringConfig(config);
  const db = openDb(paths.db);
  // Jobs the applier has already handled (submitted or skipped) are not news.
  attachApplications(db, paths.applicationsDb);
  const logger = createLogger(paths.outputDir, 'notify');
  logger.info('Notify started');

  const dryRun = process.argv.includes('--dry-run');
  const backfill = process.argv.includes('--mark-seen');

  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.RESEND_TO;
  const from = process.env.RESEND_FROM || DEFAULT_FROM;
  if (!dryRun && !backfill && (!apiKey || !to)) {
    throw new Error('RESEND_API_KEY and RESEND_TO must be set');
  }

  const markNotified = db.prepare(
    'INSERT OR IGNORE INTO notified (job_id, notified_at) VALUES (?, ?)'
  );

  // --mark-seen records the current backlog as already sent without sending it.
  // Used once at deploy time so the first real run does not mail hundreds of
  // jobs that were scanned weeks ago. It deliberately ignores the freshness
  // window: the point is to suppress everything already known.
  if (backfill) {
    const all = db.prepare(`
      SELECT j.id FROM jobs j
      JOIN scores s ON s.job_id = j.id
      WHERE s.id IN (SELECT MAX(id) FROM scores GROUP BY job_id)
        AND s.matched = 1
        AND j.id NOT IN (SELECT job_id FROM notified)
    `).all();
    db.transaction((rows) => {
      for (const job of rows) markNotified.run(job.id, nowIsoDate());
    })(all);
    logger.info(`Backfilled ${all.length} jobs as already notified`);
    console.log(JSON.stringify({ backfilled: all.length }, null, 2));
    return;
  }

  // Freshness guard. `scan` bumps last_seen for every job still listed on a
  // board, so a job that stopped being seen has almost certainly closed.
  // Without this the digest happily mails dead links.
  const maxAgeDays = config.notify?.max_age_days ?? 7;
  const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString().slice(0, 10);

  // Only jobs whose *latest* score matched and that have never been sent.
  // report.mjs re-lists every job ever scored; a digest must not.
  const jobs = db.prepare(`
    SELECT j.id, j.url, j.company, j.title, s.score, s.breakdown_json
    FROM jobs j
    JOIN scores s ON s.job_id = j.id
    WHERE s.id IN (SELECT MAX(id) FROM scores GROUP BY job_id)
      AND s.matched = 1
      AND j.id NOT IN (SELECT job_id FROM notified)
      AND j.id NOT IN (SELECT job_id FROM apps.applications WHERE status IN ('submitted', 'skipped'))
      AND j.last_seen >= ?
    ORDER BY s.score DESC, j.id ASC
    LIMIT ?
  `).all(cutoff, scoring.daily_top_n).map((row) => ({
    ...row,
    reasons: row.breakdown_json ? (JSON.parse(row.breakdown_json).reasons || []) : []
  }));

  // Capped at daily_top_n: the rest stay un-notified and compete again tomorrow.
  logger.info(`New matches seen since ${cutoff} (top ${scoring.daily_top_n}): ${jobs.length}`);

  if (jobs.length === 0) {
    // Deliberately silent. A daily "no matches" email trains you to ignore the
    // sender, which defeats the point of pushing at all.
    logger.info('No new matches; nothing sent');
    console.log(JSON.stringify({ sent: 0, new_matches: 0 }, null, 2));
    return;
  }

  const meta = { threshold: display(scoring.threshold), date: nowIsoDate() };
  const subject = `Orion — ${jobs.length} new match${jobs.length === 1 ? '' : 'es'} (${meta.date})`;
  const html = renderHtml(jobs, meta);
  const text = renderText(jobs, meta);

  if (dryRun) {
    const outPath = `${paths.outputDir}/notify-preview.html`;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(outPath, html);
    console.log(text);
    console.log(JSON.stringify({ would_send: 1, new_matches: jobs.length, preview: outPath }, null, 2));
    return;
  }

  await sendEmail({ apiKey, from, to, subject, html, text });

  // Only after the send succeeded. If it throws, nothing is marked and the
  // whole batch is retried on the next run rather than silently lost.
  db.transaction((rows) => {
    for (const job of rows) markNotified.run(job.id, nowIsoDate());
  })(jobs);

  logger.info(`Emailed ${jobs.length} matches to ${to}`);
  logger.info(`Log file: ${logger.path}`);
  console.log(JSON.stringify({ sent: 1, new_matches: jobs.length }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
