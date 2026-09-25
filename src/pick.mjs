import { loadConfig } from './config.mjs';
import { openDb, attachApplications } from './db.mjs';
import { nowIsoDate } from './utils.mjs';
import { createLogger } from './logger.mjs';
import { isStaffingAgency } from './employer.mjs';

/**
 * Choose the next jobs to apply to: the best `per_run` by score among fresh,
 * ungated postings not picked before.
 *
 * This replaces a fixed cutoff. The score is a relative ranking signal — its
 * distribution tops out in the 70s — so a 65 threshold let through about one
 * job a week while dozens of good ones sat just below it. Ranking always yields
 * the best available, and the first days drain the stored backlog best-first
 * before settling into the nightly flow.
 *
 * Each run is a batch: the nightly schedule adds one, and so does every run you
 * trigger on demand. A retry of the same run returns that run's batch.
 */
export function selectPicks(db, { date, batch = `daily-${date}`, perRun, dailyN, minScore, maxAgeDays, now = new Date().toISOString() }) {
  const limit = perRun ?? dailyN;
  // Idempotent per batch, not per day: a retry of the same run returns its
  // picks, while a separate run (on demand, or tomorrow's) picks a new set.
  const existing = db.prepare('SELECT COUNT(*) AS n FROM daily_picks WHERE batch = ?').get(batch).n;
  if (existing > 0) return { date, batch, picked: 0, existing };

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
  `).all(minScore, cutoff, limit * 5);
  const rows = [];
  for (const c of candidates) {
    if (rows.length >= limit) break;
    const key = roleKey(c.company, c.title);
    if (seenRoles.has(key)) continue;
    // Agencies reposting other employers' roles (see employer.mjs).
    if (isStaffingAgency(c.company)) continue;
    seenRoles.add(key);
    rows.push(c);
  }

  const insert = db.prepare('INSERT INTO daily_picks (pick_date, job_id, rank, score, batch, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  db.transaction((list) => list.forEach((r, i) => insert.run(date, r.id, i + 1, r.score, batch, now)))(rows);
  return { date, batch, picked: rows.length, existing: 0, topScore: rows[0]?.score ?? null, lastScore: rows.at(-1)?.score ?? null };
}

async function main() {
  const { config, paths } = loadConfig();
  const db = openDb(paths.db);
  attachApplications(db, paths.applicationsDb);
  const logger = createLogger(paths.outputDir, 'pick');
  const startedAt = Date.now();

  const opts = {
    date: nowIsoDate(),
    // One batch per Cloud Run execution; its task retries share the name, so a
    // retry reuses the batch. Local runs are a batch each.
    batch: process.env.CLOUD_RUN_EXECUTION || `local-${new Date().toISOString()}`,
    perRun: config.picks?.per_run ?? config.picks?.daily_n ?? 100,
    // A floor, not a target: below it a posting is noise even on a slow day.
    minScore: config.picks?.min_score ?? 40,
    // scan bumps last_seen for every job still listed; older means closed.
    maxAgeDays: config.picks?.max_age_days ?? 7
  };
  const result = selectPicks(db, opts);
  if (result.existing) logger.info(`Batch ${opts.batch} already has ${result.existing} picks (a retry); nothing to do`);
  else logger.info(`Picked ${result.picked} of ${opts.perRun} in batch ${opts.batch} (scores ${result.topScore ?? '-'} … ${result.lastScore ?? '-'}, floor ${opts.minScore})`);
  if (!result.existing && result.picked < opts.perRun) {
    logger.warn(`Only ${result.picked} jobs cleared the floor — supply, not ranking, is the limit this run`);
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
