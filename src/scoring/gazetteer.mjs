import { canon, isGeneric, AMBIGUOUS_TERMS } from './ontology.mjs';
import { jdSegments } from './text.mjs';

/**
 * Deterministic skill extraction: look the posting up against a vocabulary of
 * skills, instead of asking a model to generate one.
 *
 * Measured against 4,658 Gemini-labelled postings (held-out 20% split), this
 * recovers 86.5% of the skills Gemini listed at 2.8ms per posting and zero API
 * cost. A generative 3.8B model on the same task scored 0.02 Jaccard — an
 * open-vocabulary list is the one thing a small model cannot produce, while a
 * lookup does it exactly.
 *
 * Precision is lower than Gemini's (~0.34): Gemini curates ~15 salient skills,
 * this finds every technology actually named. That barely moves the final score
 * — total-score Spearman is 0.93 with 12/15 top-15 agreement — because coverage
 * is a ratio and both the numerator and denominator grow together.
 */

// Terms shorter than this are matched case-sensitively; see STRICT below.
const SHORT_TERM_LEN = 3;
const MIN_TERM_LEN = 2;
const MAX_TERM_LEN = 40;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * "go", "r", "c", "node" and friends appear constantly in ordinary prose
 * ("go to", "see r&d"). Matching them case-insensitively was the single
 * largest source of false positives, so they must appear as written — "Go",
 * "GO" — to count. AMBIGUOUS_TERMS already lists these for the keyword
 * vocabulary; reusing it keeps one source of truth.
 */
function isStrict(term) {
  return term.length <= SHORT_TERM_LEN || AMBIGUOUS_TERMS.has(canon(term));
}

// A skill boundary is not \b: "c++" and "node.js" contain characters \b treats
// as separators, so \b would match the "c" inside "c++". These lookarounds
// instead reject only a neighbour that would make the match part of a longer
// token. The trailing `\.?` is what distinguishes "node.js" — where the dot
// continues the name — from "Kubernetes." at the end of a sentence, where it
// does not. Consuming the boundary character instead of looking ahead silently
// lost every skill that ended a sentence.
const PREFIX = '(?<![A-Za-z0-9+#.])';
const SUFFIX = '(?!\\.?[A-Za-z0-9+#])';

function compile(term) {
  const body = escapeRe(term);
  const titled = escapeRe(term.replace(/^./, (c) => c.toUpperCase()));
  return {
    term,
    strict: isStrict(term),
    any: new RegExp(`${PREFIX}${body}${SUFFIX}`, 'i'),
    upper: new RegExp(`${PREFIX}${escapeRe(term.toUpperCase())}${SUFFIX}`),
    titled: new RegExp(`${PREFIX}${titled}${SUFFIX}`)
  };
}

function matches(pattern, text) {
  if (!text) return false;
  if (pattern.strict) return pattern.upper.test(text) || pattern.titled.test(text);
  return pattern.any.test(text);
}

/**
 * Build the lookup vocabulary from extractions already in the database.
 *
 * The corpus labels itself: every posting a model has already extracted
 * contributes its skill names. `minJobs` is a noise floor — a term named in
 * only one or two postings across thousands is usually a typo or a company's
 * internal tool, not a skill worth matching.
 */
export function buildGazetteer(extractions, { minJobs = 3, extraTerms = [] } = {}) {
  const jobsPerTerm = new Map();
  for (const extraction of extractions) {
    if (!extraction || typeof extraction !== 'object') continue;
    const g = extraction.entity_graph || {};
    const named = [
      ...(extraction.skills || []),
      ...(g.required_skills || []),
      ...(g.nice_to_have_skills || []),
      ...(g.tech_stack || [])
    ];
    // Per posting, not per mention: one job naming "python" five times is still
    // one job's worth of evidence that "python" is a real skill.
    const seen = new Set();
    for (const raw of named) {
      if (typeof raw !== 'string') continue;
      const term = raw.trim().toLowerCase();
      if (term.length < MIN_TERM_LEN || term.length > MAX_TERM_LEN) continue;
      if (isGeneric(canon(term))) continue;
      seen.add(term);
    }
    for (const term of seen) jobsPerTerm.set(term, (jobsPerTerm.get(term) ?? 0) + 1);
  }

  const terms = [...jobsPerTerm.entries()]
    .filter(([, n]) => n >= minJobs)
    .map(([term]) => term);
  for (const extra of extraTerms) {
    const term = String(extra).trim().toLowerCase();
    if (term.length >= MIN_TERM_LEN && term.length <= MAX_TERM_LEN) terms.push(term);
  }

  return { patterns: [...new Set(terms)].map(compile) };
}

/**
 * Split a posting's named skills into required and everything else.
 *
 * jdSegments already classifies each bullet as required / nice /
 * responsibilities / other, which is exactly the distinction the scorer's
 * `required_weight` needs — so the split costs nothing extra. When a posting
 * has no recognisable requirements section, required comes back empty and
 * skillsScore promotes the remainder, which is its existing behaviour.
 */
export function extractSkills(text, gazetteer) {
  if (!text || !gazetteer?.patterns?.length) return { skills: [], required_skills: [] };
  const segments = jdSegments(text);
  const requiredText = segments.filter((s) => s.section === 'required').map((s) => s.text).join('\n');
  const otherText = segments.filter((s) => s.section !== 'required').map((s) => s.text).join('\n');

  const required = [];
  const other = [];
  for (const pattern of gazetteer.patterns) {
    if (matches(pattern, requiredText)) required.push(pattern.term);
    else if (matches(pattern, otherText)) other.push(pattern.term);
  }
  return { skills: other, required_skills: required };
}
