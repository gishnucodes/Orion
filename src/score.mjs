import { existsSync, readFileSync } from 'node:fs';
import { loadConfig } from './config.mjs';
import { openDb } from './db.mjs';
import { nowIsoDate, safeJsonParse } from './utils.mjs';
import { createLogger } from './logger.mjs';
import { cvChunks, jdChunks, jdKeywordText, sha1 } from './scoring/text.mjs';
import {
  resolveScoringConfig, buildCvProfile, buildVocabulary, jdTerms, skillsScore, titleScore,
  keywordBodyScore, semanticScore, entityDelta, gate, combine
} from './scoring/formula.mjs';
import { createEmbedder, bestMatches } from './scoring/semantic.mjs';

const round3 = (x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : null);

function jobText(row) {
  if (row.description && row.description.length >= 200) return row.description;
  if (row.raw_path && existsSync(row.raw_path)) return readFileSync(row.raw_path, 'utf8');
  return row.description || '';
}

/**
 * Fill semantic_cache for every job that needs it, freshest postings first,
 * until the time budget runs out. Jobs left over simply score as `partial`
 * tonight and are embedded on a later run.
 */
async function refreshSemantic({ db, jobs, cv, cfg, logger }) {
  const cvHash = sha1(cv);
  const cached = new Map(db.prepare('SELECT job_id, text_hash, cv_hash, model, sims_json FROM semantic_cache').all()
    .map((r) => [r.job_id, r]));
  const sims = new Map();
  const todo = [];
  for (const job of jobs) {
    const hit = cached.get(job.id);
    if (hit && hit.text_hash === job.textHash && hit.cv_hash === cvHash && hit.model === cfg.model) {
      sims.set(job.id, safeJsonParse(hit.sims_json));
    } else {
      todo.push(job);
    }
  }
  const stats = { cached: sims.size, embedded: 0, deferred: 0, failed: false };
  if (todo.length === 0) return { sims, stats };

  let embedder;
  try {
    embedder = await createEmbedder({ model: cfg.model, dtype: cfg.dtype, batchSize: cfg.batch_size });
  } catch (err) {
    logger.error(`Embedding model unavailable (${err?.message || err}); semantic component skipped this run`);
    return { sims, stats: { ...stats, failed: true, deferred: todo.length } };
  }

  const cvVectors = await embedder.embed(cvChunks(cv));
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO semantic_cache (job_id, text_hash, cv_hash, model, sims_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  todo.sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)) || b.id - a.id);
  const deadline = Date.now() + cfg.time_budget_ms;

  for (const job of todo) {
    if (Date.now() > deadline) { stats.deferred += 1; continue; }
    const chunks = jdChunks(job.text, cfg.max_chunks);
    const result = chunks.length
      ? bestMatches(await embedder.embed(chunks.map((c) => c.text)), chunks.map((c) => c.weight), cvVectors)
      : [];
    upsert.run(job.id, job.textHash, cvHash, cfg.model, JSON.stringify(result), nowIsoDate());
    sims.set(job.id, result);
    stats.embedded += 1;
    if (stats.embedded % 250 === 0) logger.info(`Semantic: embedded ${stats.embedded}/${todo.length}`);
  }
  return { sims, stats };
}

async function main() {
  const { config, cv, paths, portals } = loadConfig();
  const db = openDb(paths.db);
  const logger = createLogger(paths.outputDir, 'score');
  const startedAt = Date.now();
  logger.info('Score (v2) started');

  const cfg = resolveScoringConfig(config);
  const negative = portals.title_filter?.negative || [];
  const positive = config.scan?.filter_by_title !== false ? portals.title_filter?.positive || [] : [];
  const allowed = config.location?.allowed || [];
  const excluded = config.location?.excluded || [];

  const rows = db.prepare(`
    SELECT j.id, j.title, j.company, j.location, j.last_seen, j.description, j.raw_path,
           e.json AS extraction_json, e.status AS extraction_status
    FROM jobs j
    LEFT JOIN extractions e ON e.id = (SELECT MAX(id) FROM extractions WHERE job_id = j.id)
  `).all();

  const jobs = rows.map((row) => {
    const text = jobText(row);
    // Any row that parses is usable, not only 'ok'. Since the skill lists come
    // from the gazetteer rather than the model, a row written during a quota
    // outage still carries real skills — it is only missing seniority, location
    // and years, all of which already degrade to title/board-derived fallbacks.
    // Gating on 'ok' here discarded that and left the job unscored entirely.
    const extraction = safeJsonParse(row.extraction_json);
    return { ...row, text, textHash: sha1(text), extraction };
  });

  // Corpus statistics: vocabulary from every extraction, document frequency
  // over every posting text. Both improve as the database grows.
  const vocab = buildVocabulary(jobs.filter((j) => j.extraction).map((j) => j.extraction), cfg.keywords.extra_terms);
  const df = new Map();
  let corpusSize = 0;
  for (const job of jobs) {
    job.terms = jdTerms(jdKeywordText(job.text), vocab);
    if (job.text) corpusSize += 1;
    for (const c of job.terms.keys()) df.set(c, (df.get(c) ?? 0) + 1);
  }
  logger.info(`Jobs=${jobs.length} with_text=${corpusSize} with_extraction=${jobs.filter((j) => j.extraction).length} vocab=${vocab.size}`);

  const cvProfile = buildCvProfile(cv);
  for (const job of jobs) {
    job.gate = gate({ title: job.title, jobLocation: job.location, extraction: job.extraction, negative, positive, allowed, excluded });
  }

  let semantic = { sims: new Map(), stats: { cached: 0, embedded: 0, deferred: 0, failed: false } };
  if (cfg.semantic.enabled) {
    const eligible = jobs.filter((j) => !j.gate.gated && j.text);
    semantic = await refreshSemantic({ db, jobs: eligible, cv, cfg: cfg.semantic, logger });
    logger.info(`Semantic: ${JSON.stringify(semantic.stats)}`);
  }

  const results = [];
  const counts = { scored: 0, unscored: 0, gated: 0, partial: 0, matched: 0 };
  for (const job of jobs) {
    if (!job.text && !job.extraction) { counts.unscored += 1; continue; }

    const sk = skillsScore(job.extraction, cvProfile, cfg.skills);
    const kt = titleScore(job.title, cfg.keywords.title_tiers);
    const kb = keywordBodyScore({
      terms: job.terms, extraction: job.extraction, company: job.company,
      df, corpusSize: Math.max(1, corpusSize), cv: cvProfile, cfg: cfg.keywords
    });
    const K = kb ? cfg.keywords.title_weight * kt.value + (1 - cfg.keywords.title_weight) * kb.value : null;
    const sem = semanticScore(semantic.sims.get(job.id), cfg.semantic);
    const delta = entityDelta({ title: job.title, extraction: job.extraction, text: job.text, cfg: cfg.entity });
    const combined = combine({
      skills: sk?.value, keywords: K, semantic: sem, delta: delta.value,
      weights: cfg.weights, minComponents: cfg.min_components
    });
    if (!combined) { counts.unscored += 1; continue; }

    // A match needs the posting text: without it keywords come only from a
    // handful of extracted skills and there is no semantic evidence at all.
    const hasText = job.text.length >= 200;
    const matched = !job.gate.gated && hasText && combined.enough && combined.score >= cfg.threshold;
    const reasons = [];
    if (job.gate.gated) reasons.push(job.gate.reason);
    if (!hasText) reasons.push('No posting text');
    if (combined.confidence === 'partial') reasons.push(`Partial: ${combined.components_used.join('+')}`);
    if (kb?.missing.length) reasons.push(`Missing keywords: ${kb.missing.slice(0, 6).join(', ')}`);
    if (!matched && !job.gate.gated && hasText && combined.score < cfg.threshold) {
      reasons.unshift(`Below threshold ${(cfg.threshold / 10).toFixed(1)}`);
    }
    if (reasons.length === 0) reasons.push('Matched');

    const breakdown = {
      version: 2,
      score: combined.score,
      confidence: combined.confidence,
      components_used: combined.components_used,
      skills: round3(sk?.value),
      keywords: round3(K),
      title: round3(kt.value),
      title_pattern: kt.pattern,
      keywords_body: round3(kb?.value),
      semantic: round3(sem),
      delta: round3(delta.value),
      delta_parts: delta.parts,
      seniority: delta.seniority,
      years_min: delta.years_min,
      domains: delta.domains,
      gate: job.gate.reason,
      skills_detail: sk && {
        cov_required: round3(sk.cov_required),
        cov_other: round3(sk.cov_other),
        matched_required: sk.matched_required,
        related_required: sk.related_required,
        missing_required: sk.missing_required
      },
      matched_keywords: kb?.matched ?? [],
      alias_keywords: kb?.alias ?? [],
      missing_keywords: kb?.missing ?? [],
      reasons
    };

    results.push({ jobId: job.id, score: combined.score, matched, breakdown });
    counts.scored += 1;
    if (job.gate.gated) counts.gated += 1;
    if (combined.confidence === 'partial') counts.partial += 1;
    if (matched) counts.matched += 1;
  }

  // Replace rather than append: only the latest score was ever read, and
  // appending ~5,000 rows a night grew the database without bound.
  const insert = db.prepare('INSERT INTO scores (job_id, score, matched, breakdown_json, created_at) VALUES (?, ?, ?, ?, ?)');
  const today = nowIsoDate();
  db.transaction(() => {
    db.prepare('DELETE FROM scores').run();
    for (const r of results) insert.run(r.jobId, r.score, r.matched ? 1 : 0, JSON.stringify(r.breakdown), today);
  })();

  const buckets = {};
  for (const r of results) {
    const b = `${Math.floor(r.score / 10) * 10}`;
    buckets[b] = (buckets[b] ?? 0) + 1;
  }
  const durationMs = Date.now() - startedAt;
  const summary = { ...counts, semantic: semantic.stats, distribution: buckets, threshold: cfg.threshold };
  db.prepare('INSERT INTO runs (run_date, stage, counts_json, duration_ms) VALUES (?, ?, ?, ?)')
    .run(today, 'score', JSON.stringify(summary), durationMs);

  logger.info(`Score finished ${JSON.stringify(summary)} in ${Math.round(durationMs / 1000)}s`);
  logger.info(`Log file: ${logger.path}`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
