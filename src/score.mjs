import { loadConfig } from './config.mjs';
import { openDb } from './db.mjs';
import { nowIsoDate } from './utils.mjs';
import { createLogger } from './logger.mjs';

function extractSkills(cvText) {
  const lines = cvText.split(/\r?\n/);
  let inSkills = false;
  const collected = [];
  for (const line of lines) {
    const heading = line.match(/^#+\s*(.+)$/);
    if (heading) {
      inSkills = /skills/i.test(heading[1]);
      continue;
    }
    if (!inSkills) continue;
    if (!line.trim()) continue;
    const cleaned = line.replace(/^[-*]\s*/, '');
    collected.push(cleaned);
  }
  const tokens = collected.join(',').split(/[,/|]/).map((s) => s.trim()).filter(Boolean);
  return Array.from(new Set(tokens.map((s) => s.toLowerCase())));
}

function matchTitle(title, positive, negative) {
  const t = (title || '').toLowerCase();
  if (negative.some((n) => t.includes(n.toLowerCase()))) return { score: 0, blocked: true };
  if (positive.some((p) => t.includes(p.toLowerCase()))) return { score: 2, blocked: false };
  return { score: 0, blocked: false };
}

function matchSkills(extractedSkills, cvSkills) {
  const ex = (extractedSkills || [])
    .filter((s) => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.toLowerCase());
  const overlap = ex.filter((s) => cvSkills.includes(s));
  if (overlap.length >= 5) return { score: 2, overlap };
  if (overlap.length >= 2) return { score: 1, overlap };
  return { score: 0, overlap };
}

function matchLocation(extraction, allowed) {
  const location = (extraction.location || '').toLowerCase();
  const remote = extraction.remote === true;
  if (remote) return 1;
  if (allowed.some((a) => location.includes(a.toLowerCase()))) return 1;
  return 0;
}

function buildReasons({ titleMatch, skillMatch, locationScore, threshold, total, entityReasons }) {
  const reasons = [];
  if (titleMatch.blocked) reasons.push('Title contains negative keyword');
  if (!titleMatch.blocked && titleMatch.score === 0) reasons.push('Title did not match positive keywords');
  if (skillMatch.score === 0) reasons.push('Skill overlap below minimum');
  if (locationScore === 0) reasons.push('Location/remote mismatch');
  if (total < threshold) reasons.push(`Score ${total.toFixed(1)} below threshold ${threshold}`);
  for (const reason of entityReasons || []) reasons.push(reason);
  if (reasons.length === 0) reasons.push('Matched');
  return reasons;
}

function computeEntityDelta(entityGraph, cvSkills, entityConfig) {
  const requiredSkills = (entityGraph.required_skills || [])
    .filter((s) => typeof s === 'string')
    .map((s) => s.toLowerCase());
  const techStack = (entityGraph.tech_stack || [])
    .filter((s) => typeof s === 'string')
    .map((s) => s.toLowerCase());
  const requiredOverlap = requiredSkills.filter((s) => cvSkills.includes(s));
  const techOverlap = techStack.filter((s) => cvSkills.includes(s));

  const preferredSeniority = (entityConfig.preferred_seniority || [])
    .filter((s) => typeof s === 'string')
    .map((s) => s.toLowerCase());
  const seniority = (entityGraph.seniority || '').toLowerCase();
  const seniorityMatch = preferredSeniority.length > 0
    ? preferredSeniority.some((s) => seniority.includes(s))
    : false;

  const disallowedEmploymentTypes = (entityConfig.disallowed_employment_types || [])
    .filter((s) => typeof s === 'string')
    .map((s) => s.toLowerCase());
  const employmentType = (entityGraph.employment_type || '').toLowerCase();
  const workAuth = (entityGraph.work_authorization || '').trim();

  const reasons = [];
  let delta = 0;

  if (disallowedEmploymentTypes.length > 0 && disallowedEmploymentTypes.some((t) => employmentType.includes(t))) {
    delta = -1;
    reasons.push('Disallowed employment type');
  }
  if (entityConfig.allow_work_auth_required === false && workAuth.length > 0) {
    delta = -1;
    reasons.push('Work authorization required');
  }

  const overlapMin = entityConfig.required_skill_overlap_bonus ?? 3;
  const positiveSignal = requiredOverlap.length >= overlapMin || (techOverlap.length > 0 && seniorityMatch);
  if (delta === 0 && positiveSignal) {
    delta = 1;
    reasons.push('Entity graph skill/stack match');
  }

  const maxDelta = entityConfig.max_delta ?? 1;
  if (delta > maxDelta) delta = maxDelta;
  if (delta < -maxDelta) delta = -maxDelta;

  return {
    delta,
    reasons,
    required_overlap: requiredOverlap,
    tech_overlap: techOverlap,
    seniority_match: seniorityMatch
  };
}

async function main() {
  const { config, cv, paths, portals } = loadConfig();
  const db = openDb(paths.db);
  const logger = createLogger(paths.outputDir, 'score');
  logger.info('Score started');

  const cvSkills = extractSkills(cv);
  const positive = portals.title_filter?.positive || [];
  const negative = portals.title_filter?.negative || [];
  const allowed = config.location?.allowed || [];
  const entityConfig = config.entity_scoring || {};

  const jobs = db.prepare(`
    SELECT j.id, j.title AS job_title, e.json AS extraction_json
    FROM jobs j
    JOIN extractions e ON e.job_id = j.id
    WHERE e.id IN (SELECT MAX(id) FROM extractions GROUP BY job_id)
  `).all();

  logger.info(`Jobs to score: ${jobs.length}`);
  for (const job of jobs) {
    const extraction = job.extraction_json ? JSON.parse(job.extraction_json) : {};
    const title = extraction.title || job.job_title || '';

    const titleMatch = matchTitle(title, positive, negative);
    const skillMatch = matchSkills(extraction.skills, cvSkills);
    const locationScore = matchLocation(extraction, allowed);

    const entityGraph = extraction.entity_graph || {};
    const entityDelta = computeEntityDelta(entityGraph, cvSkills, entityConfig);
    const baseScore = titleMatch.score + skillMatch.score + locationScore;
    const total = Math.min(5, Math.max(0, baseScore + entityDelta.delta));
    const threshold = config.match?.threshold ?? 4.0;
    const matched = !titleMatch.blocked && total >= threshold;

    const breakdown = {
      titleScore: titleMatch.score,
      skillScore: skillMatch.score,
      locationScore,
      overlap: skillMatch.overlap,
      entity_delta: entityDelta.delta,
      entity_reasons: entityDelta.reasons,
      entity_overlap: {
        required: entityDelta.required_overlap,
        tech_stack: entityDelta.tech_overlap,
        seniority_match: entityDelta.seniority_match
      },
      reasons: buildReasons({
        titleMatch,
        skillMatch,
        locationScore,
        threshold,
        total,
        entityReasons: entityDelta.reasons
      })
    };

    db.prepare('INSERT INTO scores (job_id, score, matched, breakdown_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(job.id, total, matched ? 1 : 0, JSON.stringify(breakdown), nowIsoDate());
    logger.info(`Job ${job.id} score=${total} base=${baseScore} delta=${entityDelta.delta} matched=${matched}`);
  }

  logger.info(`Score finished count=${jobs.length}`);
  logger.info(`Log file: ${logger.path}`);
  console.log(JSON.stringify({ scored: jobs.length }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
