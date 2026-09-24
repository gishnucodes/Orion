import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { decide } from '../src/apply/gate.mjs';
import { pickOption, profileAnswer, looksLikeConsent } from '../src/apply/profile.mjs';
import { answerFields } from '../src/apply/answer.mjs';
import { diffSnapshots, toLessons, learn, snapshotForm } from '../src/apply/learn.mjs';
import { EMPTY_MEMORY, section, validRewrite, appendLessons } from '../src/apply/memory.mjs';
import { normalizeKey, denormalize, executeAction } from '../src/apply/computer-use.mjs';
import { scanForm } from '../src/apply/form-scan.mjs';
import { fillAll } from '../src/apply/form-fill.mjs';
import { greenhouseIds } from '../src/apply/adapters.mjs';
import { openStore, saveApplication, handledJobIds, submittedToday, mergeFrom } from '../src/apply/store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'apply-form.html');

const PROFILE = {
  name: { first: 'Jane', last: 'Candidate', preferred: null },
  email: 'jane@example.com',
  phone: '555 0100',
  location: { city: 'New York', state: 'NY', country: 'United States' },
  links: { linkedin: 'https://linkedin.com/in/jane', github: null, website: 'https://jane.dev' },
  resume_pdf: FIXTURE, // any existing file
  work: { current_company: null },
  eligibility: { authorized_to_work_us: true, requires_sponsorship_now: null, requires_sponsorship_future: null },
  logistics: { salary_expectation: null, earliest_start: null },
  eeo: { gender: 'decline' },
  consents: { auto_accept: false },
  submit: { daily_cap: 10, never_auto_submit: ['Acme'], auto_submit_generated_essays: false }
};

// ------------------------------------------------------------------- gate

const clean = {
  mode: 'confident', ats: 'greenhouse', engine: 'dom', missing: [], review: [], failed: [], formErrors: [],
  captchaChallenge: false, company: 'Otter', neverAutoSubmit: ['Acme'], submittedToday: 0, dailyCap: 10
};

test('gate: submits only when every check passes in confident mode', () => {
  assert.equal(decide(clean).action, 'submit');
  const blockers = {
    missing: [{ id: 'f1' }], review: [{ id: 'f2' }], failed: [{ id: 'f3' }], formErrors: ['Required'],
    captchaChallenge: true, engine: 'cu', ats: 'workday', company: 'acme', submittedToday: 10
  };
  for (const [k, v] of Object.entries(blockers)) {
    assert.equal(decide({ ...clean, [k]: v }).action, 'pause', `${k} must block auto-submit`);
  }
});

test('gate: shadow mode never submits; review mode always pauses', () => {
  assert.equal(decide({ ...clean, mode: 'shadow' }).action, 'hold');
  assert.equal(decide({ ...clean, mode: 'shadow', submittedToday: 99 }).action, 'hold');
  assert.equal(decide({ ...clean, mode: 'shadow', missing: [{ id: 'x' }] }).action, 'pause');
  assert.equal(decide({ ...clean, mode: 'review' }).action, 'pause');
  for (const mode of ['shadow', 'review']) {
    for (const extra of [{}, { missing: [{}] }, { engine: 'cu' }]) {
      assert.notEqual(decide({ ...clean, ...extra, mode }).action, 'submit');
    }
  }
});

// ---------------------------------------------------------------- profile

test('pickOption maps booleans, decline and fuzzy strings', () => {
  assert.equal(pickOption(['Yes', 'No'], true), 'Yes');
  assert.equal(pickOption(['Yes, I am', 'No, I am not'], false), 'No, I am not');
  assert.equal(pickOption(['Male', 'Female', 'Decline To Self Identify'], 'decline'), 'Decline To Self Identify');
  assert.equal(pickOption(['I don\'t wish to answer', 'Yes'], 'decline'), 'I don\'t wish to answer');
  assert.equal(pickOption(['United States +1', 'Canada +1'], 'United States'), 'United States +1');
  assert.equal(pickOption(['Front End', 'Back End'], 'Mobile'), null);
});

test('profileAnswer: known facts, unknown facts, and no rule', () => {
  const f = (label, kind = 'text', options = null) => ({ id: 'x', label, kind, options });
  assert.equal(profileAnswer(f('First Name'), PROFILE).value, 'Jane');
  assert.equal(profileAnswer(f('Legal Name'), PROFILE).value, 'Jane Candidate');
  assert.equal(profileAnswer(f('Preferred Name'), PROFILE).value, 'Jane');
  assert.equal(profileAnswer(f('Email'), PROFILE).value, 'jane@example.com');
  assert.equal(profileAnswer(f('Are you authorized to work in the US?', 'yesno', ['Yes', 'No']), PROFILE).value, 'Yes');
  assert.equal(profileAnswer(f('Will you now or in the future require sponsorship?', 'yesno', ['Yes', 'No']), PROFILE).unknown, true);
  assert.equal(profileAnswer(f('GitHub URL'), PROFILE).unknown, true);
  assert.equal(profileAnswer(f('Other website'), PROFILE), null);
  assert.equal(profileAnswer(f('Gender', 'combobox', ['Male', 'Female', 'Decline To Self Identify']), PROFILE).value, 'Decline To Self Identify');
  assert.equal(profileAnswer(f('Location (City)', 'location'), PROFILE).search, 'New York');
  assert.equal(profileAnswer(f('Are you open to relocation?', 'combobox', ['Yes', 'No']), { ...PROFILE, logistics: {} }).unknown, true);
  assert.equal(profileAnswer(f('Why do you want to work here?', 'textarea'), PROFILE), null);
});

test('consent detection by label and by options', () => {
  assert.ok(looksLikeConsent('Agreement to Arbitrate'));
  assert.ok(looksLikeConsent('GDPR Disclosure', ['Acknowledge/Confirm']));
  assert.ok(looksLikeConsent('Anything', ['I understand and agree to the terms']));
  assert.ok(!looksLikeConsent('Do you have 5+ years of experience?', ['Yes', 'No']));
});

// ----------------------------------------------------------------- answers

const stubRunner = (answers) => async () => JSON.stringify({ answers });

test('answerFields: profile first, one model call for the rest, consent pauses', async () => {
  let calls = 0;
  const fields = [
    { id: 'a', label: 'First Name', kind: 'text', required: true, value: '' },
    { id: 'b', label: 'Why us?', kind: 'textarea', required: true, value: '' },
    { id: 'c', label: 'Agreement to Arbitrate', kind: 'combobox', required: true, options: ['I agree'], value: '' },
    { id: 'd', label: 'Preferred language', kind: 'radio', required: true, options: ['Python', 'Go'], value: '' },
    { id: 'e', label: 'Already filled', kind: 'text', required: true, value: 'x' }
  ];
  const runner = async (...a) => {
    calls += 1;
    return stubRunner([
      { id: 'b', value: 'Because…', source: 'generated', confidence: 'medium' },
      { id: 'd', value: 'python', source: 'cv', confidence: 'high' }
    ])(...a);
  };
  const res = await answerFields(fields, { profile: PROFILE, memory: EMPTY_MEMORY, cv: '', job: {}, model: 'm', runner });
  assert.equal(calls, 1);
  assert.equal(res.answers.get('a').value, 'Jane');
  assert.equal(res.answers.get('d').value, 'Python');
  assert.equal(res.answers.get('e').skip, true);
  assert.deepEqual(res.missing.map((m) => m.id), ['c']);
  assert.deepEqual(res.review.map((m) => m.id), ['b']); // generated essay needs review
});

test('answerFields: unknown profile facts resolve only from memory, never from the CV', async () => {
  const field = { id: 's', label: 'Will you now or in the future require sponsorship?', kind: 'yesno', required: true, options: ['Yes', 'No'], value: '' };
  const fromCv = await answerFields([field], { profile: PROFILE, memory: '', cv: '', job: {}, model: 'm', runner: stubRunner([{ id: 's', value: 'No', source: 'cv', confidence: 'high' }]) });
  assert.equal(fromCv.missing.length, 1);
  assert.equal(fromCv.answers.has('s'), false);
  const fromMemory = await answerFields([field], { profile: PROFILE, memory: '', cv: '', job: {}, model: 'm', runner: stubRunner([{ id: 's', value: 'No', source: 'memory', confidence: 'high' }]) });
  assert.equal(fromMemory.missing.length, 0);
  assert.equal(fromMemory.answers.get('s').value, 'No');
});

test('answerFields: model failure leaves required questions missing', async () => {
  const runner = async () => { throw new Error('429'); };
  const res = await answerFields([{ id: 'q', label: 'Favourite framework', kind: 'text', required: true, value: '' }],
    { profile: PROFILE, memory: '', cv: '', job: {}, model: 'm', runner });
  assert.equal(res.missing.length, 1);
});

// ------------------------------------------------------------------ memory

test('memory: sections, append fallback, and rewrite validation', () => {
  const mem = appendLessons(EMPTY_MEMORY, [
    { section: 'Answers', text: 'Requires sponsorship → No' },
    { section: 'Site notes', text: 'workday: use Autofill with Resume' }
  ]);
  assert.match(section(mem, 'Answers'), /Requires sponsorship → No/);
  assert.match(section(mem, 'Site notes'), /Autofill/);
  assert.equal(section(mem, "Don'ts"), '');
  assert.ok(validRewrite(mem, mem));
  assert.ok(!validRewrite(mem, '# Applicant memory\n## Answers\n'), 'dropping sections is rejected');
  assert.ok(!validRewrite(mem, EMPTY_MEMORY), 'wiping content is rejected');
});

test('learn: model rewrite is saved with a .bak; a bad rewrite falls back to append', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-mem-'));
  const file = path.join(dir, 'applicant-memory.md');
  fs.writeFileSync(file, EMPTY_MEMORY);
  const lessons = toLessons([{ question: 'Salary expectation?', answer: '$150k', previous: null }], 'Workday: skip the survey', { ats: 'workday' });
  assert.equal(lessons.length, 2);

  const good = EMPTY_MEMORY.replace('## Preferences\n', '## Preferences\n- Salary expectation → $150k\n');
  const r1 = await learn(lessons, { file, runner: async () => good });
  assert.equal(r1.method, 'model');
  assert.ok(fs.existsSync(`${file}.bak`));
  assert.match(fs.readFileSync(file, 'utf8'), /\$150k/);

  const r2 = await learn(lessons, { file, runner: async () => 'garbage' });
  assert.equal(r2.method, 'append');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(section(text, 'Answers'), /Salary expectation\? → \$150k/);
  assert.match(section(text, 'Site notes'), /workday: Workday: skip the survey/);
  assert.match(section(text, 'Preferences'), /\$150k/, 'earlier content survives');
});

test('diffSnapshots: new answers, corrections; skips secrets, files, consents, login pages', () => {
  const snap = (entries, loginPage = false) => ({ loginPage, fields: new Map(entries) });
  const before = snap([
    ['f1', { label: 'Salary', kind: 'text', value: '' }],
    ['f2', { label: 'Start date', kind: 'text', value: 'ASAP' }],
    ['f3', { label: 'Password', kind: 'text', value: '', sensitive: true }],
    ['f4', { label: 'Agreement to Arbitrate', kind: 'combobox', value: '' }],
    ['f5', { label: 'Unchanged', kind: 'text', value: 'same' }]
  ]);
  const after = snap([
    ['f1', { label: 'Salary', kind: 'text', value: '150k' }],
    ['f2', { label: 'Start date', kind: 'text', value: 'Nov 1' }],
    ['f3', { label: 'Password', kind: 'text', value: 'hunter2', sensitive: true }],
    ['f4', { label: 'Agreement to Arbitrate', kind: 'combobox', value: 'I agree' }],
    ['f5', { label: 'Unchanged', kind: 'text', value: 'same' }],
    ['f6', { label: 'Resume', kind: 'file', value: 'cv.pdf' }]
  ]);
  const d = diffSnapshots(before, after);
  assert.deepEqual(d.map((x) => [x.question, x.answer, x.previous]), [['Salary', '150k', null], ['Start date', 'Nov 1', 'ASAP']]);
  assert.equal(diffSnapshots(before, { ...after, loginPage: true }).length, 0);
  assert.deepEqual(toLessons(d, '', {}).map((l) => l.kind), ['answer', 'correction']);
});

// -------------------------------------------------------- computer use

test('computer use: key names and coordinate scaling', () => {
  assert.equal(normalizeKey('enter'), 'Enter');
  assert.equal(normalizeKey('ctrl+a'), 'Control+a');
  assert.equal(normalizeKey(['cmd', 'shift', 'T']), 'Meta+Shift+T');
  assert.deepEqual(denormalize(500, 500, { width: 1440, height: 900 }), [720, 450]);
  assert.deepEqual(denormalize(0, 999, { width: 1440, height: 900 }), [0, 899]);
  assert.deepEqual(denormalize(-5, 5000, { width: 1000, height: 1000 }), [0, 999]);
});

// ------------------------------------------------------------------ adapters

test('greenhouseIds: hosted URLs and custom-domain gh_jid URLs', () => {
  const portals = { tracked_companies: [{ name: 'Lyft', careers_url: 'https://boards.greenhouse.io/lyft' }] };
  assert.deepEqual(greenhouseIds({ url: 'https://job-boards.greenhouse.io/otter/jobs/8041033002' }, portals), { token: 'otter', jobId: '8041033002' });
  assert.deepEqual(greenhouseIds({ company: 'Lyft', url: 'https://app.careerpuck.com/job-board/lyft/job/8445493002?gh_jid=8445493002' }, portals), { token: 'lyft', jobId: '8445493002' });
  assert.equal(greenhouseIds({ company: 'Nobody', url: 'https://x.com/?gh_jid=1' }, portals), null);
});

// -------------------------------------------------------------------- store

test('store: lifecycle, handled set, daily count, merge keeps newest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-store-'));
  const a = openStore(path.join(dir, 'a.sqlite'));
  saveApplication(a, 1, { url: 'u1', status: 'filling' });
  saveApplication(a, 1, { status: 'submitted', submitted_at: new Date().toISOString(), gate_json: { action: 'submit' } });
  saveApplication(a, 2, { status: 'failed', error: 'x' });
  saveApplication(a, 3, { status: 'ready' });
  assert.deepEqual([...handledJobIds(a)].sort(), [1, 2]);
  assert.deepEqual([...handledJobIds(a, { retryFailed: true })], [1]);
  assert.equal(submittedToday(a), 1);
  assert.throws(() => saveApplication(a, 4, { status: 'bogus' }));

  const b = openStore(path.join(dir, 'b.sqlite'));
  saveApplication(b, 3, { status: 'skipped' }); // newer than a's row 3
  saveApplication(b, 9, { status: 'submitted' });
  a.close();
  b.close();
  const a2 = openStore(path.join(dir, 'a.sqlite'));
  assert.equal(mergeFrom(a2, path.join(dir, 'b.sqlite')), 2);
  assert.equal(a2.prepare('SELECT status FROM applications WHERE job_id = 3').get().status, 'skipped');
  assert.equal(a2.prepare('SELECT status FROM applications WHERE job_id = 1').get().status, 'submitted');
});

// ------------------------------------------------------------ browser tests

test('browser: scan, fill, snapshot diff and submit interception on a fixture form', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
  } catch {
    browser = await chromium.launch({ headless: true }).catch(() => null);
  }
  if (!browser) {
    t.skip('no Chrome/Chromium available');
    return;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`file://${FIXTURE}`);
    const fields = await scanForm(page);
    const byLabel = Object.fromEntries(fields.map((f) => [f.label, f]));
    assert.equal(byLabel['First Name'].kind, 'text');
    assert.equal(byLabel['First Name'].required, true);
    assert.equal(byLabel['Why us?'].kind, 'textarea');
    assert.deepEqual(byLabel['Pick a domain'].options, ['Front End', 'Back End']);
    assert.deepEqual(byLabel['Authorized to work?'].options, ['Yes', 'No']);
    assert.equal(byLabel['Authorized to work?'].kind, 'yesno');
    assert.deepEqual(byLabel['Country'].options, ['United States', 'Canada']);
    assert.equal(byLabel['Resume/CV'].kind, 'file');

    const answers = new Map([
      [byLabel['First Name'].id, { value: 'Jane' }],
      [byLabel['Why us?'].id, { value: 'Because.' }],
      [byLabel['Pick a domain'].id, { value: 'Back End' }],
      [byLabel['Authorized to work?'].id, { value: 'Yes' }],
      [byLabel.Country.id, { value: 'Canada' }],
      [byLabel['Resume/CV'].id, { value: FIXTURE }]
    ]);
    const { failed } = await fillAll(page, fields, answers);
    assert.deepEqual(failed, []);
    const after = Object.fromEntries((await scanForm(page)).map((f) => [f.label, f.value]));
    assert.equal(after['First Name'], 'Jane');
    assert.equal(after['Pick a domain'], 'Back End');
    assert.equal(after['Authorized to work?'], 'Yes');
    assert.equal(after.Country, 'Canada');
    assert.equal(after['Resume/CV'], 'apply-form.html');

    // The human edits a field; the diff sees it (and not the password).
    const before = await snapshotForm(page);
    await page.fill('#salary', '$150k');
    const diff = diffSnapshots(before, await snapshotForm(page));
    assert.deepEqual(diff.map((d) => [d.question, d.answer]), [['Salary expectation', '$150k']]);
    // A password box marks a login page: it is flagged sensitive, and nothing
    // on such a page is learned.
    await page.evaluate(() => {
      document.querySelector('#submit').insertAdjacentHTML('beforebegin',
        '<div class="field"><label for="pw">Password</label><input id="pw" type="password"></div>');
    });
    assert.equal((await scanForm(page)).find((f) => f.label === 'Password').sensitive, true);
    await page.fill('#pw', 'secret');
    assert.equal(diffSnapshots(before, await snapshotForm(page)).length, 0);

    // Computer Use: a click on the final submit button is intercepted, not performed.
    await page.locator('#submit').scrollIntoViewIfNeeded();
    const box = await page.locator('#submit').boundingBox();
    const r = await executeAction(page, 'click', {
      x: Math.round(((box.x + box.width / 2) / 1440) * 1000),
      y: Math.round(((box.y + box.height / 2) / 900) * 1000)
    });
    assert.equal(r.intercept, 'submit');
    assert.equal(await page.evaluate(() => window.__submitted), false);
  } finally {
    await browser.close();
  }
});
