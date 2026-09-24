/**
 * applicant.yml — the facts the agent may state about you — and the
 * deterministic rules that map common form questions onto them. Anything these
 * rules cannot answer goes to the LLM (answer.mjs) with applicant-memory.md as
 * context; anything neither can answer becomes a pause.
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { repoRoot } from '../config.mjs';

export const PROFILE_PATH = path.join(repoRoot, 'applicant.yml');

export function loadProfile(file = PROFILE_PATH) {
  if (!fs.existsSync(file)) {
    throw new Error(`${path.basename(file)} not found — copy applicant.example.yml to applicant.yml and fill it in`);
  }
  const p = yaml.load(fs.readFileSync(file, 'utf8')) || {};
  const problems = [];
  if (!p.name?.first || !p.name?.last) problems.push('name.first and name.last are required');
  if (!p.email) problems.push('email is required');
  if (!p.resume_pdf) problems.push('resume_pdf is required');
  else if (!fs.existsSync(p.resume_pdf)) problems.push(`resume_pdf does not exist: ${p.resume_pdf}`);
  if (problems.length) throw new Error(`applicant.yml: ${problems.join('; ')}`);
  p.consents ??= {};
  p.submit ??= {};
  p.submit.daily_cap ??= 10;
  p.submit.never_auto_submit ??= [];
  p.submit.auto_submit_generated_essays ??= false;
  return p;
}

/** Profile with nulls removed — what the LLM is allowed to treat as known. */
export function knownFacts(profile) {
  const prune = (v) => {
    if (v === null || v === undefined) return undefined;
    if (Array.isArray(v)) return v.length ? v : undefined;
    if (typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        const y = prune(x);
        if (y !== undefined) out[k] = y;
      }
      return Object.keys(out).length ? out : undefined;
    }
    return v;
  };
  const { submit, consents, resume_pdf, ...facts } = profile;
  return prune(facts) || {};
}

export const normLabel = (s) => String(s || '')
  .toLowerCase()
  .replace(/[*✱]/g, ' ')
  .replace(/\(required\)|\(optional\)/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const CHOICE_KINDS = new Set(['select', 'combobox', 'radio', 'yesno', 'checkboxes']);
export const isChoice = (field) => CHOICE_KINDS.has(field.kind);

const DECLINE_RE = /decline|don'?t wish|do not wish|not wish to|don'?t want|do not want|prefer not|choose not|not to (say|answer|disclose|self)|rather not|not specified|i do not want to answer/i;
const YES_RE = /^\s*(yes|y|true|i am|i do|i will|i have|agree|i agree|i understand|i acknowledge|acknowledged?)\b/i;
const NO_RE = /^\s*(no|n|false|i am not|i do not|i don'?t|i will not|i won'?t)\b/i;

/**
 * Map a desired value onto one of a field's options. Booleans match yes/no
 * style options; "decline" matches the don't-wish-to-answer option; strings
 * match exactly, then by prefix, then by containment. Returns the option text,
 * or null when nothing fits.
 */
export function pickOption(options, desired) {
  if (!Array.isArray(options) || !options.length || desired === null || desired === undefined) return null;
  const opts = options.map((o) => String(o));
  if (typeof desired === 'boolean') {
    return opts.find((o) => (desired ? YES_RE : NO_RE).test(o)) ?? null;
  }
  const want = String(desired).trim().toLowerCase();
  if (!want) return null;
  if (want === 'decline') return opts.find((o) => DECLINE_RE.test(o)) ?? null;
  if (want === 'yes' || want === 'true') return pickOption(opts, true);
  if (want === 'no' || want === 'false') return pickOption(opts, false);
  const lower = opts.map((o) => o.trim().toLowerCase());
  let i = lower.indexOf(want);
  if (i < 0) i = lower.findIndex((o) => o.startsWith(want) || want.startsWith(o));
  if (i < 0) i = lower.findIndex((o) => o.includes(want) || (o.length > 3 && want.includes(o)));
  return i >= 0 ? opts[i] : null;
}

const CONSENT_RE = /\b(i agree|agree to|agreement|arbitrat|acknowledg|consent|certif|attest|terms (of|and)|privacy (policy|notice)|i have read|i understand|read the .* (policy|notice|agreement)|gdpr|disclosure|\bpolicy\b)/i;
const CONSENT_OPTION_RE = /acknowledg|i agree|i understand|i accept|i consent|i certify|i have read|confirm/i;
/**
 * Legal acknowledgements — by label, or by options that only make sense as one
 * ("Acknowledge/Confirm", "I understand and agree…").
 */
export const looksLikeConsent = (label, options) => CONSENT_RE.test(normLabel(label))
  || (Array.isArray(options) && options.length > 0 && options.length <= 3 && options.some((o) => CONSENT_OPTION_RE.test(String(o))));

/**
 * Deterministic answers from applicant.yml, by question label.
 *   null                         no rule for this question → ask the LLM
 *   { key, value }               answered
 *   { key, unknown: true }       a profile fact the question needs is null → pause
 * Choice fields get their value mapped to an option (null if none matches, which
 * the caller treats as unanswered).
 */
export function profileAnswer(field, profile) {
  const label = normLabel(field.label);
  if (!label && field.kind !== 'file') return null;
  const p = profile;
  const fullName = `${p.name.first} ${p.name.last}`;
  const loc = p.location || {};
  const cityState = [loc.city, loc.state].filter(Boolean).join(', ');

  const eeo = (key) => ({ key: `eeo.${key}`, value: p.eeo?.[key] ?? 'decline' });
  const fact = (key, value) => (value === null || value === undefined ? { key, unknown: true } : { key, value });

  let hit = null;
  if (field.kind === 'file') {
    if (/resume|cv\b|curriculum/.test(label) || label === '' || /attach/.test(label)) hit = { key: 'resume_pdf', value: p.resume_pdf, file: true };
    else return null; // cover letters etc: optional unless required → LLM/pause
  } else if (/preferred (first )?name|nickname/.test(label)) hit = { key: 'name.preferred', value: p.name.preferred || p.name.first };
  else if (/first name|given name/.test(label)) hit = { key: 'name.first', value: p.name.first };
  else if (/last name|surname|family name/.test(label)) hit = { key: 'name.last', value: p.name.last };
  else if (/^(full |legal |your )?name$|full name|legal name|^name \(/.test(label)) hit = { key: 'name', value: fullName };
  else if (/e-?mail/.test(label)) hit = { key: 'email', value: p.email };
  else if (/phone|mobile|cell/.test(label) && !/country|type/.test(label)) hit = fact('phone', p.phone);
  else if (/linkedin/.test(label)) hit = fact('links.linkedin', p.links?.linkedin);
  else if (/github/.test(label)) hit = fact('links.github', p.links?.github);
  else if (/website|portfolio|personal (site|url|page)|blog/.test(label) && !/other/.test(label)) hit = fact('links.website', p.links?.website);
  else if (/^country( of residence)?$/.test(label)) hit = fact('location.country', loc.country);
  else if (/^(current )?location$|where are you (currently )?(located|based)|current (city|location)|^city$|location \(city/.test(label)) {
    hit = fact('location', cityState || null);
    if (hit.value) hit.search = loc.city;
  } else if (/current (company|employer)|^company$|most recent (company|employer)/.test(label)) hit = fact('work.current_company', p.work?.current_company);
  else if (/current (job )?(title|role|position)/.test(label)) hit = fact('work.current_title', p.work?.current_title);
  else if (/sponsor/.test(label)) {
    const future = /future|now or|will you (now )?.*require/.test(label);
    hit = future
      ? fact('eligibility.requires_sponsorship_future', p.eligibility?.requires_sponsorship_future)
      : fact('eligibility.requires_sponsorship_now', p.eligibility?.requires_sponsorship_now);
  } else if (/authori[sz]ed to work|legally (authori[sz]ed|eligible|able)|eligible to work|right to work|work authori[sz]ation/.test(label)) hit = fact('eligibility.authorized_to_work_us', p.eligibility?.authorized_to_work_us);
  else if (/relocat/.test(label)) hit = fact('logistics.willing_to_relocate', p.logistics?.willing_to_relocate);
  else if (/in[- ]person|on-?site|in (the |our )?office|hybrid|days (per|a) week/.test(label)) hit = fact('logistics.open_to_onsite', p.logistics?.open_to_onsite);
  else if (/salary|compensation|pay (range|expectation)|desired (pay|pay rate)/.test(label)) hit = fact('logistics.salary_expectation', p.logistics?.salary_expectation);
  else if (/start date|earliest .*start|when can you start|notice period|available to start|want to start/.test(label)) hit = fact('logistics.earliest_start', p.logistics?.earliest_start);
  else if (/hispanic|latin[oa]/.test(label)) hit = eeo('hispanic_latino');
  else if (/\brace\b|ethnicit/.test(label)) hit = eeo('race');
  else if (/gender|\bsex\b/.test(label) && !/orientation/.test(label)) hit = eeo('gender');
  else if (/veteran/.test(label)) hit = eeo('veteran');
  else if (/disabilit/.test(label)) hit = eeo('disability');
  if (!hit) return null;
  if (hit.unknown || hit.file) return hit;

  if (isChoice(field)) {
    const options = field.options || [];
    // Comboboxes whose options are only known after typing (location
    // autocompletes) are matched at fill time instead.
    if (!options.length) return hit;
    const option = pickOption(options, hit.value);
    return option ? { ...hit, value: option } : { key: hit.key, unknown: true, reason: `no option matches "${hit.value}"` };
  }
  if (typeof hit.value === 'boolean') return { ...hit, value: hit.value ? 'Yes' : 'No' };
  if (field.kind === 'checkbox') return null;
  return hit;
}
