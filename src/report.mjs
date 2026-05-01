import { loadConfig } from './config.mjs';
import { openDb } from './db.mjs';
import { nowIsoDate } from './utils.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.mjs';

function formatJob(job) {
  const reasons = job.reasons?.length ? ` | reasons: ${job.reasons.join('; ')}` : '';
  return `- ${job.company || 'Unknown'} | ${job.title || 'Untitled'} | ${job.url} | score ${job.score.toFixed(1)}${reasons}`;
}

async function main() {
  const { config, paths } = loadConfig();
  const db = openDb(paths.db);
  mkdirSync(paths.outputDir, { recursive: true });
  const logger = createLogger(paths.outputDir, 'report');
  logger.info('Report started');

  const rows = db.prepare(`
    SELECT j.url, j.company, j.title, s.score, s.matched, s.breakdown_json
    FROM jobs j
    JOIN scores s ON s.job_id = j.id
    WHERE s.id IN (SELECT MAX(id) FROM scores GROUP BY job_id)
    ORDER BY s.score DESC
  `).all();

  const withReasons = rows.map((r) => {
    const breakdown = r.breakdown_json ? JSON.parse(r.breakdown_json) : {};
    return { ...r, reasons: breakdown.reasons || [] };
  });

  const matched = withReasons.filter((r) => r.matched === 1);
  const below = withReasons.filter((r) => r.matched !== 1);

  const lines = [];
  lines.push(`# Daily Apply List — ${nowIsoDate()}`);
  lines.push('');
  lines.push(`Threshold: ${config.match?.threshold ?? 4.0}`);
  lines.push('');
  lines.push('## Apply (Manual)');
  if (matched.length === 0) {
    lines.push('- None');
  } else {
    for (const job of matched) lines.push(formatJob(job));
  }
  lines.push('');
  lines.push('## Below Threshold');
  if (below.length === 0) {
    lines.push('- None');
  } else {
    for (const job of below) lines.push(formatJob(job));
  }
  lines.push('');

  const outPath = path.join(paths.outputDir, `daily-${nowIsoDate()}.md`);
  writeFileSync(outPath, lines.join('\n'));
  logger.info(`Report written ${outPath}`);
  logger.info(`Log file: ${logger.path}`);
  console.log(outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
