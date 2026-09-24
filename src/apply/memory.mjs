/**
 * applicant-memory.md — what the agent has learned from you. Every time it
 * gets stuck and you fill something in (or leave a note), learn.mjs asks
 * Gemini to rewrite this file with the new knowledge folded in. It is loaded
 * into every answer prompt and every Computer Use run, so a question you
 * answered once is answered from memory next time.
 *
 * The file is plain markdown so you can read and edit it by hand; the agent
 * preserves your edits (it rewrites, but from the current contents).
 */
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../config.mjs';
import { runGemini } from '../gemini.mjs';

export const MEMORY_PATH = path.join(repoRoot, 'applicant-memory.md');
export const SECTIONS = ['Answers', 'Preferences', 'Site notes', "Don'ts"];

export const EMPTY_MEMORY = `# Applicant memory

Learned from your input during applications. Edit freely — the agent rewrites
this file from its current contents, so your changes are kept.

## Answers
<!-- Canonical question → answer, generalized so it matches other wordings. -->

## Preferences

## Site notes
<!-- How-to per ATS or company, e.g. "Workday: click Autofill with Resume". -->

## Don'ts
`;

export function loadMemory(file = MEMORY_PATH) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : EMPTY_MEMORY;
}

export function saveMemory(text, file = MEMORY_PATH) {
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
}

/** Lines under a `## heading` (for injecting only Site notes into CU prompts). */
export function section(memory, heading) {
  const re = new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  const m = memory.match(re);
  if (!m) return '';
  const rest = memory.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return (next >= 0 ? rest.slice(0, next) : rest).replace(/<!--[\s\S]*?-->/g, '').trim();
}

/**
 * A rewrite is accepted only if it kept the structure and did not silently
 * drop most of what was there — a model that "summarizes" the file away would
 * otherwise erase everything learned so far.
 */
export function validRewrite(oldText, newText) {
  if (typeof newText !== 'string' || !newText.trim()) return false;
  if (!SECTIONS.every((s) => new RegExp(`^## ${s}\\s*$`, 'm').test(newText))) return false;
  const bodyLen = (t) => SECTIONS.map((s) => section(t, s)).join('\n').length;
  return bodyLen(newText) >= bodyLen(oldText) * 0.6;
}

/** Deterministic fallback: append the raw lessons under their sections. */
export function appendLessons(memory, lessons) {
  let out = memory;
  for (const heading of SECTIONS) {
    const lines = lessons.filter((l) => l.section === heading).map((l) => `- ${l.text}`);
    if (!lines.length) continue;
    const re = new RegExp(`^## ${heading}\\s*$`, 'm');
    const m = out.match(re);
    if (!m) {
      out = `${out.trimEnd()}\n\n## ${heading}\n${lines.join('\n')}\n`;
      continue;
    }
    const start = m.index + m[0].length;
    const rest = out.slice(start);
    const next = rest.search(/^## /m);
    const insertAt = next >= 0 ? start + next : out.length;
    out = `${out.slice(0, insertAt).trimEnd()}\n${lines.join('\n')}\n\n${out.slice(insertAt)}`;
  }
  return out;
}

const MERGE_SYSTEM = `You maintain a job applicant's memory file: a markdown document the applicant's
application agent reads before filling forms. You receive the current file and
new lessons (form answers the applicant typed in by hand when the agent was
stuck, corrections of the agent's answers, and free-text notes). Return the
COMPLETE rewritten file.

Rules:
- Keep exactly these level-2 sections, in order: ## Answers, ## Preferences,
  ## Site notes, ## Don'ts. Keep the title and intro paragraph.
- Answers: one bullet per canonical question: "- <generalized question> → <answer>".
  Generalize the wording so it matches other phrasings of the same question
  ("Will you now or in the future require visa sponsorship?" → "Requires visa
  sponsorship (now or future)"). Merge duplicates. When a new answer conflicts
  with an old one, the NEW one wins — replace, do not list both.
- A correction (the agent's answer was replaced) is also a Don't when the
  agent's answer was a factual mistake.
- Company-specific essays ("Why <Company>?") are NOT stored verbatim; at most
  record a one-line reusable takeaway under Preferences.
- Site notes: "- <ATS or company or domain>: <how-to>".
- Keep every existing entry that is not superseded. Preserve manual edits.
- Never store passwords, security codes, or government ID numbers.
- Output only the markdown file. No code fences, no commentary.`;

/**
 * Fold lessons into the memory file via Gemini; returns the new text.
 * lessons: [{ kind: 'answer'|'correction'|'note', question?, answer?, previous?, options?, text?, context }]
 */
export async function mergeLessons(memory, lessons, { model, apiKey, runner = runGemini } = {}) {
  const prompt = [
    'CURRENT FILE:',
    '<<<',
    memory.trim(),
    '>>>',
    '',
    'NEW LESSONS (JSON):',
    JSON.stringify(lessons, null, 2),
    '',
    'Return the complete rewritten file.'
  ].join('\n');
  const text = await runner(model, { temp: 0.1, num_predict: 4096 }, prompt, {
    apiKey, json: false, system: MERGE_SYSTEM, timeoutMs: 90000
  });
  return text.replace(/^```(?:markdown|md)?\s*\n/, '').replace(/\n```\s*$/, '').trim();
}
