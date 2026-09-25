/**
 * Orion auto-applier — `npm run apply`.
 *
 * Opens a visible Chrome window (persistent profile, so logins you do by hand
 * stick), works through matched jobs best-score-first, fills each application,
 * and submits only when the gate (gate.mjs) is satisfied; otherwise it pauses
 * and asks you, learning from what you type into applicant-memory.md.
 *
 *   npm run apply -- [--mode shadow|review|confident] [--limit N] [--job ID ...]
 *                    [--retry-failed] [--no-sync]
 *
 * Modes: shadow (default) fills and gates but never clicks Submit; review
 * always pauses before Submit; confident auto-submits when every check passes.
 *
 * Interactive only — this never runs in the nightly Cloud Run job.
 */
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { loadConfig, repoRoot } from '../config.mjs';
import { createLogger } from '../logger.mjs';
import { pull, push, isPreconditionFailure } from '../gcs-sync.mjs';
import { openStore, saveApplication, handledJobIds, submittedToday, mergeFrom } from './store.mjs';
import { loadProfile } from './profile.mjs';
import { loadMemory, MEMORY_PATH } from './memory.mjs';
import { scanForm, isEmptyValue } from './form-scan.mjs';
import { fillAll, probeOptions, formErrors } from './form-fill.mjs';
import { pickAdapter, isClosed, SUCCESS_TEXT } from './adapters.mjs';
import { answerFields } from './answer.mjs';
import { decide } from './gate.mjs';
import { captchaChallengeVisible } from './captcha.mjs';
import { runComputerUse } from './computer-use.mjs';
import { pauseForHuman, closePrompt, ask, color as c } from './pause.mjs';

class Quit extends Error {}

const { values: args } = parseArgs({
  options: {
    mode: { type: 'string', default: 'shadow' },
    limit: { type: 'string', default: '5' },
    job: { type: 'string', multiple: true },
    'retry-failed': { type: 'boolean', default: false },
    'no-sync': { type: 'boolean', default: false }
  }
});
if (!['shadow', 'review', 'confident'].includes(args.mode)) {
  console.error(`--mode must be shadow, review or confident (got ${args.mode})`);
  process.exit(2);
}

const { config, portals, cv, paths } = loadConfig();
const applyCfg = config.apply || {};
const logger = createLogger(paths.outputDir, 'apply');
const log = (m) => logger.info(m);
const bucket = args['no-sync'] ? null : (process.env.GCS_BUCKET || applyCfg.gcs_bucket || null);
const JOBS_OBJECT = process.env.GCS_DB_OBJECT || 'jobs.sqlite';
const APPS_OBJECT = process.env.GCS_APPLICATIONS_OBJECT || 'applications.sqlite';
const MEMORY_OBJECT = 'applicant-memory.md';
const snapshotPath = path.join(path.dirname(paths.db), 'jobs.snapshot.sqlite');

let apiKey = process.env.GEMINI_APPLY_API_KEY;
if (!apiKey && process.env.GEMINI_API_KEY) {
  apiKey = process.env.GEMINI_API_KEY;
  log('GEMINI_APPLY_API_KEY not set — falling back to GEMINI_API_KEY (shares the nightly extraction quota)');
}
const answerModel = process.env.GEMINI_APPLY_MODEL || applyCfg.answer_model || 'gemini-3.5-flash';
const cuModel = process.env.GEMINI_CU_MODEL || applyCfg.cu_model || 'gemini-3.8-flash';

// ------------------------------------------------------------------ syncing

let appsGeneration = null;

async function syncDown(store) {
  if (!bucket) {
    log('sync off — using local databases');
    return;
  }
  await pull(bucket, JOBS_OBJECT, snapshotPath, log);
  const tmp = path.join(os.tmpdir(), `orion-apps-${process.pid}.sqlite`);
  appsGeneration = await pull(bucket, APPS_OBJECT, tmp, log);
  if (appsGeneration) {
    const merged = mergeFrom(store, tmp);
    if (merged) log(`merged ${merged} application row(s) from GCS`);
    fs.rmSync(tmp, { force: true });
  }
  if (!fs.existsSync(MEMORY_PATH)) await pull(bucket, MEMORY_OBJECT, MEMORY_PATH, log).catch(() => {});
}

/** Upload applications.sqlite; on a lost race re-pull, merge, retry once. */
async function syncUp(store) {
  if (!bucket) return;
  const quiet = () => {};
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      appsGeneration = await push(bucket, APPS_OBJECT, paths.applicationsDb, { ifGenerationMatch: appsGeneration ?? 0, log: quiet });
      return;
    } catch (err) {
      if (!isPreconditionFailure(err) || attempt === 2) {
        log(`applications upload failed: ${err.message}`);
        return;
      }
      const tmp = path.join(os.tmpdir(), `orion-apps-${process.pid}.sqlite`);
      appsGeneration = await pull(bucket, APPS_OBJECT, tmp, quiet);
      if (appsGeneration) mergeFrom(store, tmp);
      fs.rmSync(tmp, { force: true });
    }
  }
}

async function syncMemoryUp() {
  if (!bucket || !fs.existsSync(MEMORY_PATH)) return;
  await push(bucket, MEMORY_OBJECT, MEMORY_PATH).catch((err) => log(`memory upload failed: ${err.message}`));
}

// -------------------------------------------------------------------- queue

function loadQueue(store) {
  const dbPath = fs.existsSync(snapshotPath) ? snapshotPath : paths.db;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const base = `
      SELECT j.id, j.url, j.company, j.title, j.location, j.source, j.description, s.score, s.matched
      FROM jobs j JOIN scores s ON s.id = (SELECT MAX(id) FROM scores WHERE job_id = j.id)`;
    if (args.job?.length) {
      const ids = args.job.flatMap((v) => v.split(',')).map(Number).filter(Boolean);
      return db.prepare(`${base} WHERE j.id IN (${ids.map(() => '?').join(',')}) ORDER BY s.score DESC`).all(...ids);
    }
    const maxAge = applyCfg.max_age_days ?? 14;
    const cutoff = new Date(Date.now() - maxAge * 86400000).toISOString().slice(0, 10);
    const handled = handledJobIds(store, { retryFailed: args['retry-failed'] });
    return db.prepare(`${base} WHERE s.matched = 1 AND j.last_seen >= ? ORDER BY s.score DESC, j.id ASC`).all(cutoff)
      .filter((j) => !handled.has(j.id))
      .slice(0, Number(args.limit) || 5);
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------ helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForOutcome(page, isSuccess, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(800);
    if (await isSuccess(page).catch(() => false)) return 'success';
    if (await captchaChallengeVisible(page)) return 'captcha';
  }
  return 'unknown';
}

const genericSuccess = async (page) => SUCCESS_TEXT.test(await page.evaluate(() => document.body?.innerText || '').catch(() => ''));

async function confirmationShot(page, jobId) {
  const dir = path.join(paths.outputDir, 'applications', String(jobId));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `confirmation-${Date.now()}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  return path.relative(repoRoot, file);
}

// ----------------------------------------------------------- one application

async function applyOne(job, env) {
  const { store, getPage } = env;
  const adapter = pickAdapter(job);
  const ats = adapter?.name || (/myworkdayjobs|workday/i.test(job.url) ? 'workday' : 'generic');
  let engine = adapter ? 'dom' : 'cu';
  const title = `#${job.id} ${job.title} — ${job.company} (${ats}, score ${Math.round(job.score)})`;
  console.log(`\n${c.bold('▶')} ${title}\n  ${c.dim(job.url)}`);
  saveApplication(store, job.id, { url: job.url, company: job.company, title: job.title, ats, engine, status: 'filling', error: null });
  env.current = job.id;

  const context = { ats, company: job.company, domain: (() => { try { return new URL(job.url).hostname; } catch { return ''; } })() };
  const learnOpts = { model: answerModel, apiKey, onChange: () => { env.memory = loadMemory(); env.memoryDirty = true; } };
  const page = getPage();
  const pause = (o) => pauseForHuman(getPage(), { title, context, learnOpts, log, ...o });
  const shadow = args.mode === 'shadow';

  const target = adapter ? await adapter.applyUrl(job, { portals }) : job.url;
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(2500);
  if (await isClosed(page)) {
    console.log(c.dim('  posting is closed'));
    saveApplication(store, job.id, { status: 'failed', error: 'posting closed' });
    return;
  }

  const answerCtx = () => ({ profile: env.profile, memory: env.memory, cv, job, model: answerModel, apiKey, log });
  let answersLog = {};
  let missing = [];
  let review = [];
  let failed = [];
  let submitPoint = null;

  // --------------------------------------------------------- fill (DOM)
  if (engine === 'dom') {
    let fields = await scanForm(page);
    if (fields.length < 3) {
      console.log(c.dim(`  only ${fields.length} field(s) found — switching to Computer Use`));
      engine = 'cu';
    } else {
      fields = await adapter.enrich(job, fields, { portals });
      for (const f of fields) {
        if (f.kind === 'combobox' && !f.options?.length) f.options = await probeOptions(page, f);
      }
      const res = await answerFields(fields, answerCtx());
      ({ missing, review } = res);
      console.log(c.dim(`  ${fields.length} fields · ${res.answers.size} answered · ${missing.length} missing · ${review.length} to review`));
      const fill = await fillAll(page, fields, res.answers, (m) => console.log(c.dim(m)));
      failed = fill.failed;
      answersLog = Object.fromEntries([...res.answers].map(([id, a]) => {
        const f = fields.find((x) => x.id === id);
        return [f?.label || id, { value: a.value, source: a.source, confidence: a.confidence }];
      }));
    }
  }

  // --------------------------------------------------------- fill (CU)
  if (engine === 'cu') {
    saveApplication(store, job.id, { engine });
    const cuPause = async (reason, kind) => {
      const keys = ['c', 'd', 'k', 'l', 'q'];
      const choice = await pause({ reasons: [`${kind === 'safety' ? 'Safety check' : 'Agent needs you'}: ${reason}`], keys });
      if (choice === 'q') throw new Quit();
      return { c: 'continue', d: 'done', k: 'skip', l: 'leave' }[choice];
    };
    const cuAnswer = async (question, options) => {
      const field = { id: 'q', label: question, kind: options?.length ? 'radio' : 'text', options: options || null, required: true, value: '' };
      const res = await answerFields([field], answerCtx());
      const a = res.answers.get('q');
      return a && !res.missing.length ? { value: a.value, source: a.source } : null;
    };
    const r = await runComputerUse({
      getPage, job, profile: env.profile, memory: env.memory, apiKey, model: cuModel,
      log: (m) => console.log(c.dim(m)), pause: cuPause, answer: cuAnswer
    });
    if (r.outcome === 'skip') return saveApplication(store, job.id, { status: 'skipped' });
    if (r.outcome === 'leave') return saveApplication(store, job.id, { status: 'needs_human' });
    if (r.outcome === 'done') return markSubmitted(job, env, getPage());
    if (r.outcome === 'gave_up') missing = [{ id: 'cu', label: 'Computer Use stopped', reason: r.summary }];
    if (r.unfilled?.length) missing = r.unfilled.map((u) => ({ id: u, label: u, reason: 'reported unfilled by the agent' }));
    submitPoint = r.submitPoint || null;
    answersLog = { summary: r.summary, steps: r.steps };
  }

  // --------------------------------------------------------- gate / submit loop
  const submit = async () => {
    const p = getPage();
    if (engine === 'dom') {
      const btn = p.locator(adapter.submitSelector).first();
      await btn.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await btn.click({ timeout: 10000 });
    } else if (submitPoint) {
      await p.mouse.click(submitPoint[0], submitPoint[1]);
    } else {
      throw new Error('no submit target known — submit it yourself and choose [d]');
    }
    return waitForOutcome(p, adapter ? adapter.isSuccess : genericSuccess);
  };

  for (let round = 1; ; round += 1) {
    const p = getPage();
    const captcha = await captchaChallengeVisible(p);
    const errors = await formErrors(p);
    if (round > 1 && engine === 'dom') {
      // You worked on the form: recompute what is still empty from the page.
      const now = await scanForm(p);
      missing = now.filter((f) => f.required && isEmptyValue(f.value))
        .map((f) => ({ id: f.id, label: f.label, reason: 'still empty' }));
      failed = [];
      review = [];
    }
    const decision = decide({
      mode: args.mode, ats, engine, missing, review, failed, formErrors: errors, captchaChallenge: captcha,
      company: job.company, neverAutoSubmit: env.profile.submit.never_auto_submit,
      submittedToday: submittedToday(store), dailyCap: env.profile.submit.daily_cap
    });
    saveApplication(store, job.id, { answers_json: answersLog, missing_json: missing, gate_json: decision });
    log(`job ${job.id} gate: ${decision.action} — ${decision.reasons.join('; ')}`);

    let choice;
    if (decision.action === 'hold') {
      console.log(`  ${c.cyan('◆ would submit')} ${c.dim(decision.reasons.join('; '))}`);
      return saveApplication(store, job.id, { status: 'ready' });
    }
    if (decision.action === 'submit') {
      console.log(`  ${c.green('● auto-submitting')} ${c.dim(decision.reasons.join('; '))}`);
      choice = 's';
    } else {
      const keys = shadow ? ['r', 'd', 'k', 'l', 'q'] : ['s', 'r', 'd', 'k', 'l', 'q'];
      choice = await pause({ reasons: decision.reasons, missing, review, keys });
    }

    if (choice === 'q') throw new Quit();
    if (choice === 'k') return saveApplication(store, job.id, { status: 'skipped' });
    if (choice === 'l') return saveApplication(store, job.id, { status: shadow ? 'ready' : 'needs_human' });
    if (choice === 'd') return markSubmitted(job, env, getPage());
    if (choice === 'r') continue;
    if (choice === 's') {
      let outcome;
      try {
        outcome = await submit();
      } catch (err) {
        console.log(c.red(`  submit failed: ${err.message.split('\n')[0]}`));
        continue;
      }
      if (outcome === 'success') return markSubmitted(job, env, getPage(), { verified: true });
      if (outcome === 'captcha') {
        const k = await pause({ reasons: ['A CAPTCHA appeared on submit — solve it in the window (the agent never does)'], keys: ['d', 'k', 'l', 'q'] });
        if (k === 'q') throw new Quit();
        if (k === 'd') return markSubmitted(job, env, getPage());
        return saveApplication(store, job.id, { status: k === 'k' ? 'skipped' : 'needs_human' });
      }
      // No confirmation seen: show the page state and ask again.
      console.log(c.yellow('  no confirmation detected after submit'));
    }
  }
}

async function markSubmitted(job, env, page, { verified = false } = {}) {
  let ok = verified || (await (pickAdapter(job)?.isSuccess || genericSuccess)(page).catch(() => false));
  if (!ok) {
    const k = await ask(`  No confirmation page detected. Mark #${job.id} as submitted anyway? [y/n] `, ['y', 'n']);
    ok = k === 'y';
  }
  if (!ok) return saveApplication(env.store, job.id, { status: 'needs_human' });
  const shot = await confirmationShot(page, job.id);
  saveApplication(env.store, job.id, { status: 'submitted', submitted_at: new Date().toISOString(), screenshot_path: shot });
  console.log(`  ${c.green('✔ submitted')} ${c.dim(shot)}`);
}

// --------------------------------------------------------------------- main

async function main() {
  const profile = loadProfile();
  fs.mkdirSync(path.dirname(paths.applicationsDb), { recursive: true });
  const store = openStore(paths.applicationsDb);
  await syncDown(store);
  if (!apiKey) console.log(c.yellow('No Gemini key (GEMINI_APPLY_API_KEY) — custom questions will all pause for you.'));

  const queue = loadQueue(store);
  console.log(`${c.bold('Orion apply')} · mode ${c.bold(args.mode)} · ${queue.length} job(s) · submitted today ${submittedToday(store)}/${profile.submit.daily_cap}`);
  if (!queue.length) {
    closePrompt();
    return;
  }

  const profileDir = (applyCfg.chrome_profile || '~/.orion/chrome-profile').replace(/^~(?=$|\/)/, os.homedir());
  fs.mkdirSync(profileDir, { recursive: true });
  const browser = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1440, height: 900 },
    acceptDownloads: false
  });
  let page = browser.pages()[0] || await browser.newPage();
  // Flows that open the form in a new tab (Workday, "Apply" buttons) move the
  // agent to that tab.
  browser.on('page', (p) => { page = p; });
  const env = { store, profile, memory: loadMemory(), getPage: () => page, current: null, memoryDirty: false };

  const finish = async (code) => {
    if (env.current) {
      const row = store.prepare('SELECT status FROM applications WHERE job_id = ?').get(env.current);
      if (row?.status === 'filling') saveApplication(store, env.current, { status: 'needs_human' });
    }
    await syncUp(store);
    if (env.memoryDirty) await syncMemoryUp();
    closePrompt();
    await browser.close().catch(() => {});
    process.exit(code);
  };
  process.on('SIGINT', () => {
    console.log('\ninterrupted');
    finish(130);
  });

  for (const job of queue) {
    try {
      await applyOne(job, env);
    } catch (err) {
      if (err instanceof Quit) {
        console.log('quitting');
        return finish(0);
      }
      console.log(c.red(`  failed: ${err.message.split('\n')[0]}`));
      log(`job ${job.id} failed: ${err.stack || err.message}`);
      saveApplication(store, job.id, { status: 'failed', error: err.message.slice(0, 500) });
    }
    env.current = null;
    await syncUp(store);
    if (env.memoryDirty) {
      await syncMemoryUp();
      env.memoryDirty = false;
    }
  }

  const rows = store.prepare(`SELECT status, COUNT(*) n FROM applications WHERE job_id IN (${queue.map(() => '?').join(',')}) GROUP BY status`).all(...queue.map((j) => j.id));
  console.log(`\n${c.bold('Done')} · ${rows.map((r) => `${r.status} ${r.n}`).join(' · ')}`);
  await finish(0);
}

main().catch((err) => {
  console.error('[apply] fatal:', err?.stack || err);
  process.exit(1);
});
