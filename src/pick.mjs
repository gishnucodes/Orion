import { loadConfig } from './config.mjs';
import { openDb, attachApplications } from './db.mjs';
import { nowIsoDate } from './utils.mjs';
import { createLogger } from './logger.mjs';

/**
 * Choose today's jobs to apply to: the best `daily_n` by score among fresh,
 * ungated postings not picked before.
 *
 * This replaces a fixed cutoff. The score is a relative ranking signal — its
 * distribution tops out in the 70s — so a 65 threshold let through about one
 * job a week while dozens of good ones sat just below it. Ranking always yields
 * the best available, and the first days drain the stored backlog best-first
 * before settling into the nightly flow.
 *
 * Idempotent per day: a re-run on the same date returns the existing picks.
 */
export function selectPicks(db, { date, dailyN, minScore, maxAgeDays }) {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM daily_picks WHERE pick_date = ?').get(date).n;
  if (existing > 0) return { date, picked: 0, existing };

  const cutoff = new Date(new Date(`${date}T00:00:00Z`).getTime() - maxAgeDays * 86400000).toISOString().slice(0, 10);
  // Many employers post one role once per location. You apply once, so a role
  // (company + title) is picked once: here, and on every later day.
  const roleKey = (company, title) => `${String(company || '').trim().toLowerCase()}|${String(title || '').replace(/\s+/g, ' ').trim().toLowerCase()}`;
  const seenRoles = new Set(db.prepare(`
    SELECT j.company, j.title FROM daily_picks p JOIN jobs j ON j.id = p.job_id
  `).all().map((r) => roleKey(r.company, r.title)));
  const candidates = db.prepare(`
    SELECT j.id, j.company, j.title, s.score
    FROM jobs j
    JOIN scores s ON s.id = (SELECT MAX(id) FROM scores WHERE job_id = j.id)
    WHERE json_extract(s.breakdown_json, '$.gate') IS NULL
      AND s.score >= ?
      AND j.last_seen >= ?
      AND j.id NOT IN (SELECT job_id FROM daily_picks)
      AND j.id NOT IN (SELECT job_id FROM apps.applications WHERE status IN ('submitted', 'skipped'))
    ORDER BY s.score DESC, j.first_seen DESC, j.id ASC
    LIMIT ?
  `).all(minScore, cutoff, dailyN * 5);
  const rows = [];
  for (const c of candidates) {
    if (rows.length >= dailyN) break;
    const key = roleKey(c.company, c.title);
    if (seenRoles.has(key)) continue;
    seenRoles.add(key);
    rows.push(c);
  }

  const insert = db.prepare('INSERT INTO daily_picks (pick_date, job_id, rank, score) VALUES (?, ?, ?, ?)');
  db.transaction((list) => list.forEach((r, i) => insert.run(date, r.id, i + 1, r.score)))(rows);
  return { date, picked: rows.length, existing: 0, topScore: rows[0]?.score ?? null, lastScore: rows.at(-1)?.score ?? null };
}

async function main() {
  const { config, paths } = loadConfig();
  const db = openDb(paths.db);
  attachApplications(db, paths.applicationsDb);
  const logger = createLogger(paths.outputDir, 'pick');
  const startedAt = Date.now();

  const opts = {
    date: nowIsoDate(),
    dailyN: config.picks?.daily_n ?? 50,
    // A floor, not a target: below it a posting is noise even on a slow day.
    minScore: config.picks?.min_score ?? 40,
    // scan bumps last_seen for every job still listed; older means closed.
    maxAgeDays: config.picks?.max_age_days ?? 7
  };
  const result = selectPicks(db, opts);
  if (result.existing) logger.info(`Picks for ${opts.date} already exist (${result.existing}); nothing to do`);
  else logger.info(`Picked ${result.picked} of ${opts.dailyN} for ${opts.date} (scores ${result.topScore ?? '-'} … ${result.lastScore ?? '-'}, floor ${opts.minScore})`);
  if (!result.existing && result.picked < opts.dailyN) {
    logger.warn(`Only ${result.picked} jobs cleared the floor — supply, not ranking, is the limit today`);
  }

  db.prepare('INSERT INTO runs (run_date, stage, counts_json, duration_ms) VALUES (?, ?, ?, ?)')
    .run(opts.date, 'pick', JSON.stringify(result), Date.now() - startedAt);
  console.log(JSON.stringify(result, null, 2));
}

// Run only as a script, so tests can import selectPicks without side effects.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
