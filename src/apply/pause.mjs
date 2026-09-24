/**
 * Terminal side of a pause: explain why the agent stopped, let you work in the
 * browser window, then learn from whatever you changed there.
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { snapshotForm, diffSnapshots, toLessons, learn } from './learn.mjs';

let rl = null;
const iface = () => (rl ??= readline.createInterface({ input: stdin, output: stdout }));
export function closePrompt() {
  rl?.close();
  rl = null;
}

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`
};
export { c as color };

export const CHOICES = {
  s: 'submit now (the agent clicks Submit)',
  r: 're-check the form (after you fixed things)',
  c: 'continue (hand control back to the agent)',
  d: 'I submitted it myself',
  k: 'skip this job for good',
  l: 'leave it for a later run',
  q: 'quit'
};

export async function ask(question, keys) {
  for (;;) {
    const answer = (await iface().question(question)).trim().toLowerCase().slice(0, 1);
    if (keys.includes(answer)) return answer;
    stdout.write(c.dim(`  choose one of: ${keys.join(', ')}\n`));
  }
}

export async function askLine(question) {
  return (await iface().question(question)).trim();
}

/**
 * Pause for the human. Snapshots the form before and after, diffs, asks for an
 * optional note, and folds both into applicant-memory.md.
 *
 * opts: { title, reasons[], missing[], review[], keys[], context, learnOpts, log }
 * returns the chosen key.
 */
export async function pauseForHuman(page, opts) {
  const { title, reasons = [], missing = [], review = [], keys, context, learnOpts = {}, log = () => {} } = opts;
  stdout.write(`\n${c.yellow('━━ Paused')} ${c.bold(title)}\n`);
  for (const r of reasons) stdout.write(`   • ${r}\n`);
  if (missing.length) {
    stdout.write(c.bold('   Needs your answer:\n'));
    for (const m of missing) stdout.write(`     - ${m.label.slice(0, 90)} ${c.dim(`(${m.reason})`)}\n`);
  }
  if (review.length) {
    stdout.write(c.bold('   Please review:\n'));
    for (const m of review) stdout.write(`     - ${m.label.slice(0, 90)} ${c.dim(`(${m.reason})`)}\n`);
  }
  stdout.write(c.dim('   Work in the Chrome window as needed, then choose:\n'));
  for (const k of keys) stdout.write(`   [${k}] ${CHOICES[k]}\n`);

  const before = await snapshotForm(page).catch(() => null);
  await page.bringToFront().catch(() => {});
  const choice = await ask('   > ', keys);
  if (choice === 'q') return choice;

  // Learn from what you did in the window.
  const after = before ? await snapshotForm(page).catch(() => null) : null;
  const changes = before && after ? diffSnapshots(before, after) : [];
  if (changes.length) {
    stdout.write(c.bold(`   You filled/changed ${changes.length} field(s):\n`));
    for (const ch of changes) {
      const v = Array.isArray(ch.answer) ? ch.answer.join(', ') : ch.answer;
      stdout.write(`     ${ch.previous ? c.yellow('~') : c.green('+')} ${ch.question.slice(0, 70)} → ${String(v).slice(0, 70)}\n`);
    }
  }
  const note = await askLine('   Anything the agent should know next time? (enter to skip) ');
  const lessons = toLessons(changes, note, context);
  if (lessons.length) {
    const res = await learn(lessons, { ...learnOpts, log });
    if (res.changed) {
      stdout.write(c.cyan(`   applicant-memory.md updated (${res.method}):\n`));
      for (const l of res.removed.slice(0, 8)) stdout.write(c.red(`     - ${l.slice(0, 110)}\n`));
      for (const l of res.added.slice(0, 12)) stdout.write(c.green(`     + ${l.slice(0, 110)}\n`));
      learnOpts.onChange?.();
    }
  }
  return choice;
}
