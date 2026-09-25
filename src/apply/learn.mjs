/**
 * Learning from you. Whenever the agent pauses, it snapshots the form; when you
 * hand control back it snapshots again. The difference — fields you filled in
 * or changed — plus an optional note you type, becomes a set of lessons that
 * memory.mjs folds into applicant-memory.md.
 *
 * Never learned: password/secret fields (form-scan marks them `sensitive`),
 * anything on a page that has a password box (a login page), file uploads, and
 * legal acknowledgements (your answer to one arbitration clause says nothing
 * about the next).
 */
import { scanForm, isEmptyValue } from './form-scan.mjs';
import { looksLikeConsent } from './profile.mjs';
import { loadMemory, saveMemory, mergeLessons, validRewrite, appendLessons } from './memory.mjs';

/** label/value snapshot of every field on the page, keyed by field id. */
export async function snapshotForm(page) {
  let fields = [];
  try {
    fields = await scanForm(page);
  } catch {
    return { url: safeUrl(page), fields: new Map(), loginPage: false };
  }
  const loginPage = await page.locator('input[type="password"]').count().then((n) => n > 0).catch(() => false);
  return {
    url: safeUrl(page),
    loginPage,
    fields: new Map(fields.map((f) => [f.id, { label: f.label, kind: f.kind, options: f.options, value: f.value, sensitive: f.sensitive }]))
  };
}

function safeUrl(page) {
  try {
    return page.url();
  } catch {
    return '';
  }
}

const norm = (v) => (Array.isArray(v) ? [...v].sort().join(' | ') : String(v ?? '').trim());

/**
 * Fields whose value you set or changed between two snapshots.
 * @returns [{ question, answer, previous, kind, options }]
 */
export function diffSnapshots(before, after) {
  if (after.loginPage || before.loginPage) return [];
  const out = [];
  for (const [id, a] of after.fields) {
    if (a.sensitive || a.kind === 'file' || isEmptyValue(a.value) || !a.label) continue;
    if (looksLikeConsent(a.label, a.options)) continue;
    const b = before.fields.get(id);
    if (b && norm(b.value) === norm(a.value)) continue;
    out.push({
      question: a.label,
      answer: Array.isArray(a.value) ? a.value : String(a.value),
      previous: b && !isEmptyValue(b.value) ? b.value : null,
      kind: a.kind,
      options: a.options?.length ? a.options.slice(0, 20) : undefined
    });
  }
  return out;
}

/** Turn a diff + note into the lesson records memory.mjs merges. */
export function toLessons(changes, note, context) {
  const lessons = changes.map((c) => ({
    kind: c.previous ? 'correction' : 'answer',
    question: c.question,
    answer: c.answer,
    ...(c.previous ? { previous: c.previous } : {}),
    ...(c.options ? { options: c.options } : {}),
    context
  }));
  if (note && note.trim()) lessons.push({ kind: 'note', text: note.trim(), context });
  return lessons;
}

/**
 * Merge lessons into applicant-memory.md. Falls back to a plain append when
 * the model is unavailable or its rewrite fails validation, so nothing you
 * typed is ever lost. Returns { changed, method, added: [lines], removed: [lines] }.
 */
export async function learn(lessons, { model, apiKey, runner, log = () => {}, file } = {}) {
  if (!lessons.length) return { changed: false };
  const before = loadMemory(file);
  let after = null;
  let method = 'model';
  try {
    const rewritten = await mergeLessons(before, lessons, { model, apiKey, runner });
    if (validRewrite(before, rewritten)) after = rewritten;
    else log('memory rewrite failed validation — appending instead');
  } catch (err) {
    log(`memory merge model failed (${err.message.split('\n')[0]}) — appending instead`);
  }
  if (!after) {
    method = 'append';
    after = appendLessons(before, lessons.map((l) => (l.kind === 'note'
      ? { section: 'Site notes', text: `${l.context?.ats || l.context?.domain || 'general'}: ${l.text}` }
      : { section: 'Answers', text: `${l.question} → ${Array.isArray(l.answer) ? l.answer.join(', ') : l.answer}` })));
  }
  saveMemory(after, file);
  const beforeLines = new Set(before.split('\n'));
  const afterLines = new Set(after.split('\n'));
  return {
    changed: true,
    method,
    added: [...afterLines].filter((l) => l.trim() && !beforeLines.has(l)),
    removed: [...beforeLines].filter((l) => l.trim() && !afterLines.has(l))
  };
}
