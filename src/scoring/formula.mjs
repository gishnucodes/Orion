/**
 * Scoring v2 — pure functions, no I/O.
 *
 *   base  = w_s·Sk + w_k·K + w_m·Sem      (weights renormalised over available parts)
 *   Score = 100 · clamp(base + Δ, 0, 1)
 *
 *   Sk  skills coverage of the extracted required / other skill lists
 *   K   0.25·Kt (title tier) + 0.75·Kb (ATS match rate: JD keywords found in the CV)
 *   Sem per-requirement embedding coverage (sims computed in semantic.mjs)
 *   Δ   seniority, years, employment type, sponsorship, domain — bounded
 *
 * Location and blocked title words are gates (pass/fail), not score components.
 */
import { canon, relatedTo, isGeneric, AMBIGUOUS_TERMS, ONTOLOGY_TERMS } from './ontology.mjs';
import { normKey, ngramCounts, splitCamelJoins, cleanCv } from './text.mjs';

export const DEFAULTS = {
  weights: { skills: 0.30, keywords: 0.45, semantic: 0.25 },
  skills: { required_weight: 0.7, alpha: 2, prior: 0.3, related_credit: 0.5 },
  keywords: {
    title_weight: 0.25,
    top_k: 25,
    required_boost: 1.5,
    alias_credit: 0.7,
    alpha: 2,
    prior: 0.3,
    extra_terms: [],
    title_tiers: []
  },
  semantic: {
    enabled: true,
    model: 'Xenova/bge-small-en-v1.5',
    dtype: 'q8',
    tau_lo: 0.55,
    tau_hi: 0.80,
    max_chunks: 40,
    batch_size: 32,
    time_budget_ms: 1800000
  },
  entity: {
    your_years: 5,
    seniority_delta: {
      intern: -0.10, junior: -0.05, mid: 0.05, senior: 0.05, staff: 0,
      principal: -0.05, manager: -0.10, director_plus: -0.10, unknown: 0
    },
    years_bonus: 0.03,
    years_penalty: 0.03,
    years_penalty_span: 3,
    disallowed_employment_types: [],
    employment_penalty: 0.10,
    requires_sponsorship: false,
    sponsorship_penalty: 0.10,
    domains: [],
    domain_min: 2,
    domain_bonus: 0.02,
    delta_min: -0.15,
    delta_max: 0.10
  },
  threshold: 65,
  min_components: 2,
  daily_top_n: 15
};

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, over) {
  if (!isObject(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

export function resolveScoringConfig(config = {}) {
  return merge(DEFAULTS, config.scoring_v2 || {});
}

const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const strings = (arr) => (Array.isArray(arr) ? arr.filter((s) => typeof s === 'string' && s.trim()) : []);

/* ---------------------------------------------------------------- CV ---- */

/** Literal n-grams and canonical skills present anywhere in the CV. */
export function buildCvProfile(cvText) {
  const grams = ngramCounts(cleanCv(cvText));
  const literal = new Set(grams.keys());
  const canonSet = new Set();
  for (const key of literal) canonSet.add(canon(key));
  return { literal, canonSet };
}

/* ------------------------------------------------------------ Skills ---- */

function canonList(arr, exclude) {
  const out = [];
  const seen = new Set();
  for (const s of strings(arr)) {
    const k = canon(s);
    if (!k || isGeneric(k) || seen.has(k) || exclude?.has(k)) continue;
    seen.add(k);
    out.push({ key: k, label: s.trim() });
  }
  return out;
}

export function skillsScore(extraction, cv, cfg) {
  if (!extraction) return null;
  const g = extraction.entity_graph || {};
  let R = canonList(g.required_skills);
  let N = canonList(
    [...strings(extraction.skills), ...strings(g.tech_stack), ...strings(g.nice_to_have_skills)],
    new Set(R.map((x) => x.key))
  );
  if (R.length === 0) { R = N; N = []; }
  if (R.length === 0) return null;

  const credit = (key) => {
    if (cv.canonSet.has(key)) return 1;
    for (const r of relatedTo(key)) if (cv.canonSet.has(r)) return cfg.related_credit;
    return 0;
  };
  const cov = (list) => {
    let sum = 0;
    const matched = [];
    const related = [];
    const missing = [];
    for (const { key, label } of list) {
      const c = credit(key);
      sum += c;
      (c === 1 ? matched : c > 0 ? related : missing).push(label);
    }
    return { value: (sum + cfg.alpha * cfg.prior) / (list.length + cfg.alpha), matched, related, missing };
  };

  const r = cov(R);
  const n = N.length ? cov(N) : null;
  const value = n ? cfg.required_weight * r.value + (1 - cfg.required_weight) * n.value : r.value;
  return {
    value,
    cov_required: r.value,
    cov_other: n ? n.value : null,
    matched_required: r.matched,
    related_required: r.related,
    missing_required: r.missing
  };
}

/* ---------------------------------------------------------- Keywords ---- */

export function titleScore(title, tiers) {
  const key = ` ${normKey(splitCamelJoins(title))} `;
  let best = { value: 0, pattern: null };
  for (const tier of tiers || []) {
    for (const pattern of tier.patterns || []) {
      if (tier.weight > best.value && key.includes(` ${normKey(pattern)} `)) {
        best = { value: tier.weight, pattern };
      }
    }
  }
  return best;
}

/**
 * Keyword vocabulary: every skill Gemini has ever extracted in the corpus, the
 * ontology, and configured extras. Map normKey -> display label.
 */
export function buildVocabulary(extractions, extraTerms = [], minJobs = 2) {
  const vocab = new Map();
  const add = (label) => {
    const key = normKey(label);
    const words = key.split(' ').length;
    if (!key || words > 4 || AMBIGUOUS_TERMS.has(key) || isGeneric(canon(key))) return;
    if (!vocab.has(key)) vocab.set(key, String(label).trim());
  };
  // An extracted skill joins the vocabulary once it shows up in minJobs postings;
  // one-off extractions ("Discovery", "CAP") are mostly noise. Corpus terms go in
  // first so display labels keep their original casing ("BigQuery", not "bigquery").
  const seen = new Map();
  for (const ex of extractions) {
    const g = ex.entity_graph || {};
    const labels = new Map();
    for (const s of [...strings(ex.skills), ...strings(g.required_skills), ...strings(g.tech_stack), ...strings(g.nice_to_have_skills)]) {
      labels.set(normKey(s), s);
    }
    for (const [key, label] of labels) {
      const entry = seen.get(key) ?? { label, jobs: 0 };
      entry.jobs += 1;
      seen.set(key, entry);
    }
  }
  for (const { label, jobs } of seen.values()) if (jobs >= minJobs) add(label);
  for (const t of extraTerms) add(t);
  for (const t of ONTOLOGY_TERMS) add(t);
  return vocab;
}

/** Vocabulary terms present in a JD, grouped by canonical key. */
export function jdTerms(text, vocab) {
  const terms = new Map();
  if (!text) return terms;
  for (const [key, count] of ngramCounts(text)) {
    if (!vocab.has(key)) continue;
    const c = canon(key);
    const entry = terms.get(c) ?? { tf: 0, surfaces: new Map() };
    // max, not sum: "google cloud platform" also contains the n-gram "google cloud".
    entry.tf = Math.max(entry.tf, count);
    entry.surfaces.set(key, vocab.get(key));
    terms.set(c, entry);
  }
  return terms;
}

/**
 * Kb — the ATS "match rate": what share of the JD's important keywords appear in
 * the CV. Literal presence earns full credit; a synonym-only match earns
 * alias_credit and is reported, since a literal-matching ATS may miss it.
 */
export function keywordBodyScore({ terms, extraction, company, df, corpusSize, cv, cfg }) {
  const candidates = new Map();
  for (const [c, entry] of terms) candidates.set(c, { tf: entry.tf, surfaces: new Map(entry.surfaces), extracted: false });

  const g = extraction?.entity_graph || {};
  const extracted = extraction
    ? [...strings(extraction.skills), ...strings(g.required_skills), ...strings(g.tech_stack), ...strings(g.nice_to_have_skills)]
    : [];
  for (const label of extracted) {
    const c = canon(label);
    if (!c || isGeneric(c)) continue;
    const entry = candidates.get(c) ?? { tf: 1, surfaces: new Map(), extracted: true };
    entry.extracted = true;
    entry.surfaces.set(normKey(label), label.trim());
    candidates.set(c, entry);
  }

  const companyKey = normKey(company);
  const required = new Set(strings(g.required_skills).map(canon));
  const scored = [];
  for (const [c, entry] of candidates) {
    if (companyKey && (c === companyKey || entry.surfaces.has(companyKey))) continue;
    const idf = Math.log(1 + corpusSize / (1 + (df.get(c) ?? 0)));
    const u = (1 + Math.log(entry.tf)) * idf * (required.has(c) ? cfg.required_boost : 1);
    scored.push({ c, u, ...entry });
  }
  if (scored.length === 0) return null;

  scored.sort((a, b) => b.u - a.u);
  const Q = scored.filter((t, i) => i < cfg.top_k || t.extracted);

  let num = 0;
  let den = 0;
  const matched = [];
  const alias = [];
  const missing = [];
  for (const t of Q) {
    const label = [...t.surfaces.values()][0];
    let hit = 0;
    if ([...t.surfaces.keys()].some((k) => cv.literal.has(k))) hit = 1;
    else if (cv.canonSet.has(t.c)) hit = cfg.alias_credit;
    num += t.u * hit;
    den += t.u;
    (hit === 1 ? matched : hit > 0 ? alias : missing).push(label);
  }
  // Same shrinkage as the skills ratio, in units of an average keyword: a JD
  // with 2 keywords that both hit is weak evidence, not a perfect match rate.
  const meanU = den / Q.length;
  const value = (num + cfg.alpha * cfg.prior * meanU) / (den + cfg.alpha * meanU);
  return { value, keyword_count: Q.length, matched, alias, missing };
}

/* ---------------------------------------------------------- Semantic ---- */

export function semanticScore(sims, cfg) {
  if (!Array.isArray(sims) || sims.length === 0) return null;
  let num = 0;
  let den = 0;
  for (const [s, v] of sims) {
    num += v * clamp((s - cfg.tau_lo) / (cfg.tau_hi - cfg.tau_lo));
    den += v;
  }
  return den > 0 ? num / den : null;
}

/* ------------------------------------------------------------ Entity ---- */

const SENIORITY_RULES = [
  ['intern', /\b(intern|internship|co-?op)\b/i],
  ['director_plus', /\b(director|vp|vice president|head of|head,|chief|cto|ceo|executive)\b/i],
  ['manager', /\b(manager|mgr|management)\b/i],
  ['principal', /\b(principal|distinguished|fellow)\b/i],
  // "Member of Technical Staff" is a flat title at AI labs, not a staff level.
  ['staff', /\b((?<!technical )staff|lead|tech lead)\b/i],
  ['senior', /\b(senior|sr\.?|iii)\b/i],
  ['junior', /\b(junior|jr\.?|entry[- ]level|new grad|graduate|early[- ]career)\b|\b(engineer|developer|scientist) I\b(?!I)/i],
  ['mid', /\b(mid(?![- ]?market)([- ]?(level|senior))?|intermediate|ii)\b/i]
];

const LEVELS = new Set(['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'manager', 'director_plus']);

export function seniorityLevel(title, extraction) {
  const fromText = (text) => {
    for (const [level, re] of SENIORITY_RULES) if (re.test(text || '')) return level;
    return null;
  };
  const extracted = extraction?.entity_graph?.seniority_level;
  return fromText(splitCamelJoins(title))
    ?? (LEVELS.has(extracted) ? extracted : null)
    ?? fromText(extraction?.seniority || extraction?.entity_graph?.seniority)
    ?? 'unknown';
}

const YEARS_RE = /(\d{1,2})\s*\+?\s*(?:(?:-|–|to)\s*\d{1,2}\s*\+?\s*)?(?:years|yrs)\b[^.\n]{0,60}?experience/gi;

export function yearsMin(extraction, text) {
  const n = extraction?.entity_graph?.years_experience_min ?? extraction?.years_experience;
  if (typeof n === 'number' && n >= 0 && n <= 20) return n;
  const found = [...String(text || '').matchAll(YEARS_RE)].map((m) => Number(m[1])).filter((v) => v >= 1 && v <= 15);
  return found.length ? Math.min(...found) : null;
}

const NO_SPONSOR_RE = /(\b(unable|not able|cannot|can't|will not|won't|do not|does not|don't|no longer)\s+(currently\s+)?(to\s+)?(provide|offer|support)?\s*(visa\s+|immigration\s+)?sponsor|without (the need for )?(current or future )?(visa |employment visa )?sponsorship|\bno (visa )?sponsorship\b|not (eligible|available) for (visa )?sponsorship)/i;

export function entityDelta({ title, extraction, text, cfg }) {
  const parts = {};
  const level = seniorityLevel(title, extraction);
  parts.seniority = cfg.seniority_delta[level] ?? 0;

  const y = yearsMin(extraction, text);
  if (y === null) parts.years = 0;
  else if (y <= cfg.your_years) parts.years = cfg.years_bonus;
  else parts.years = -cfg.years_penalty * Math.min(1, (y - cfg.your_years) / cfg.years_penalty_span);

  const employment = `${extraction?.entity_graph?.employment_type || ''} ${title || ''}`.toLowerCase();
  parts.employment = strings(cfg.disallowed_employment_types).some((t) => employment.includes(t.toLowerCase()))
    ? -cfg.employment_penalty : 0;

  const visa = `${extraction?.entity_graph?.visa_sponsorship || ''} ${extraction?.entity_graph?.work_authorization || ''}`;
  parts.sponsorship = cfg.requires_sponsorship && (NO_SPONSOR_RE.test(text || '') || NO_SPONSOR_RE.test(visa))
    ? -cfg.sponsorship_penalty : 0;

  const grams = text ? ngramCounts(text) : new Map();
  const domainsHit = strings(cfg.domains).filter((d) => grams.has(normKey(d)));
  parts.domain = domainsHit.length >= cfg.domain_min ? cfg.domain_bonus : 0;

  const sum = Object.values(parts).reduce((a, b) => a + b, 0);
  return {
    value: clamp(sum, cfg.delta_min, cfg.delta_max),
    parts,
    seniority: level,
    years_min: y,
    domains: domainsHit
  };
}

/* ------------------------------------------------------------- Gates ---- */

const US_STATE_CODE = /,\s*(AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/;

/** Whole-word; short all-caps tokens ("US", "UK") are case-sensitive so "join us" is not the US. */
function mentions(haystack, needle) {
  if (!haystack || !needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flags = needle.length <= 3 && needle === needle.toUpperCase() ? '' : 'i';
  return new RegExp(`(^|[^A-Za-z])${escaped}([^A-Za-z]|$)`, flags).test(haystack);
}

/**
 * Location segments ("SF, CA | London, UK"; "... or Remote within Canada") are
 * classified separately, and a foreign place wins over a stray state code so
 * "Toronto, ON, CA" is not California.
 */
function classifyPlace(segment, usTokens, excluded) {
  const foreign = excluded.find((e) => mentions(segment, e));
  if (foreign) return { kind: 'foreign', token: foreign };
  if (US_STATE_CODE.test(segment) || /\b(USA|U\.S\.A?\.?)\b/.test(segment) || usTokens.some((a) => mentions(segment, a))) {
    return { kind: 'us' };
  }
  if (/\b(remote|north america|amer|americas)\b/i.test(segment)) return { kind: 'us' };
  return { kind: 'unknown' };
}

export function gate({ title, jobLocation, extraction, negative = [], positive = [], allowed = [], excluded = [] }) {
  const t = (title || '').toLowerCase();
  const blocked = negative.find((n) => t.includes(n.toLowerCase()));
  if (blocked) return { gated: true, reason: `Title contains "${blocked}"` };
  // Same rule scan applies to new jobs; catches rows ingested before the filter existed.
  if (positive.length && !positive.some((p) => t.includes(p.toLowerCase()))) {
    return { gated: true, reason: 'Title not a target role' };
  }

  // Only an explicitly non-US location is gated; unknown or unlisted US places pass.
  const usTokens = allowed.filter((a) => a.toLowerCase() !== 'remote');
  const segments = [jobLocation, extraction?.location, extraction?.entity_graph?.location]
    .filter(Boolean)
    .flatMap((p) => String(p).split(/[;|•/]|\s+or\s+/))
    .map((p) => p.trim())
    .filter(Boolean);
  const kinds = segments.map((p) => classifyPlace(p, usTokens, excluded));
  const titleForeign = excluded.find((e) => mentions(title, e));
  const anyUs = kinds.some((k) => k.kind === 'us');
  const foreign = kinds.find((k) => k.kind === 'foreign')?.token ?? titleForeign;
  if (foreign && !anyUs) return { gated: true, reason: `Location outside target (${foreign})` };
  return { gated: false, reason: null };
}

/* ----------------------------------------------------------- Combine ---- */

export function combine({ skills, keywords, semantic, delta, weights, minComponents }) {
  const parts = [
    ['skills', skills, weights.skills],
    ['keywords', keywords, weights.keywords],
    ['semantic', semantic, weights.semantic]
  ].filter(([, v]) => typeof v === 'number');
  if (parts.length === 0) return null;
  const wsum = parts.reduce((a, [, , w]) => a + w, 0);
  const base = parts.reduce((a, [, v, w]) => a + v * w, 0) / wsum;
  return {
    score: Math.round(1000 * clamp(base + (delta ?? 0))) / 10,
    base,
    components_used: parts.map(([name]) => name),
    confidence: parts.length === 3 ? 'full' : 'partial',
    enough: parts.length >= minComponents
  };
}
