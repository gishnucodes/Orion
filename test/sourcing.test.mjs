import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalUrl, jobKey, titleAllowed, JOB_KEY_VERSION } from '../src/utils.mjs';
import { companyFromUrl, isStaffingAgency, prettyName } from '../src/employer.mjs';
import { gate, requiresCitizenship } from '../src/scoring/formula.mjs';
import { openDb, attachApplications } from '../src/db.mjs';
import { selectPicks } from '../src/pick.mjs';
import { pickRows, recentPickRows, rowsNotInSheet, HEADER } from '../src/sheet.mjs';
import { JUNK_BOARD } from '../tools/import-slugs.mjs';

/* ------------------------------------------------------------ identity ---- */

test('one Greenhouse job has one key, however it is linked', () => {
  // Getro links the board; Okta's own board links its careers site.
  assert.equal(jobKey('https://boards.greenhouse.io/okta/jobs/8220634'), 'gh:8220634');
  assert.equal(jobKey('https://www.okta.com/company/careers/opportunity/8220634?gh_jid=8220634'), 'gh:8220634');
  assert.equal(jobKey('https://job-boards.greenhouse.io/okta/jobs/8220634?gh_src=abc'), 'gh:8220634');
});

test('Ashby and Lever jobs are keyed by their UUID', () => {
  const id = '3f2a1b4c-1111-2222-3333-444455556666';
  assert.equal(jobKey(`https://jobs.ashbyhq.com/cursor/${id}`), `ashby:${id}`);
  assert.equal(jobKey(`https://jobs.lever.co/zilliz/${id.toUpperCase()}/apply`), `lever:${id}`);
});

test('other URLs fall back to a canonical form without tracking params', () => {
  assert.equal(
    jobKey('https://www.Example.com/Careers/job/9/?utm_source=getro&ref=x'),
    'https://example.com/Careers/job/9'
  );
  // A job id carried in the query survives canonicalisation.
  assert.equal(canonicalUrl('https://stripe.com/jobs/listing?gh_jid=123&utm_medium=x'), 'https://stripe.com/jobs/listing?gh_jid=123');
});

test('rows written under older key rules are re-keyed on open', () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'orion-')), 'jobs.sqlite');
  let db = openDb(file);
  db.prepare("INSERT INTO jobs (url, url_key) VALUES (?, 'stale')").run('https://boards.greenhouse.io/okta/jobs/1');
  db.prepare("UPDATE schema_meta SET value = '0' WHERE key = 'job_key_version'").run();
  db.close();
  db = openDb(file);
  assert.equal(db.prepare('SELECT url_key FROM jobs').get().url_key, 'gh:1');
  assert.equal(db.prepare("SELECT value FROM schema_meta WHERE key = 'job_key_version'").get().value, String(JOB_KEY_VERSION));
});

/* ------------------------------------------------------------ employer ---- */

test('acquired portfolio labels resolve to the real employer', () => {
  assert.equal(companyFromUrl('https://apply.careers.microsoft.com/careers/job/1', 'Yammer'), 'Microsoft');
  assert.equal(companyFromUrl('https://careers.hpe.com/us/en/job/1', 'Nimble Storage'), 'HPE');
});

test('an aggregator label that agrees with the URL is kept', () => {
  assert.equal(companyFromUrl('https://snapchat.wd1.myworkdayjobs.com/x/job/1', 'Snap Inc.'), 'Snap Inc.');
  assert.equal(companyFromUrl('https://boards.greenhouse.io/anthropic/jobs/1', 'Anthropic'), 'Anthropic');
  assert.equal(companyFromUrl('https://vercel.com/careers/x', 'Vercel'), 'Vercel');
});

/* -------------------------------------------------------------- filters ---- */

test('title negatives match whole words, hyphen included in the word', () => {
  const pos = ['Software Engineer', 'Solutions Engineer'];
  const neg = ['Intern', 'Sales', 'Crypto'];
  assert.ok(titleAllowed('Software Engineer, Internal Tools', pos, neg));
  assert.ok(titleAllowed('Pre-Sales Solutions Engineer', pos, neg));
  assert.ok(titleAllowed('Software Engineer, Cryptography', pos, neg));
  assert.ok(!titleAllowed('Software Engineer Intern', pos, neg));
  assert.ok(!titleAllowed('Sales Engineer', ['Engineer'], neg));
});

test('ISO country codes gate foreign locations without matching ordinary words', () => {
  const allowed = ['Remote', 'United States', 'US', 'California'];
  const excluded = ['Canada', 'Denmark', 'CAN', 'DNK', 'KSA'];
  const g = (loc) => gate({ title: 'Software Engineer', jobLocation: loc, extraction: null, allowed, excluded }).gated;
  assert.ok(g('Aarhus, DNK'));
  assert.ok(g('Toronto, CAN'));
  assert.ok(g('Remote, KSA'));          // "remote" alone must not make it US
  assert.ok(!g('Seattle, WA'));
  assert.ok(!g('San Francisco, CA; Toronto, CAN')); // any US location passes
  assert.ok(!gate({ title: 'Engineers who can ship', jobLocation: 'Remote', extraction: null, allowed, excluded }).gated);
});

test('a generic "Remote" does not rescue a posting that names only a foreign place', () => {
  const allowed = ['Remote', 'United States', 'US'];
  const excluded = ['Paris', 'Toronto', 'UK', 'Latin America'];
  const g = (title, loc) => gate({ title, jobLocation: loc, extraction: null, allowed, excluded }).gated;
  assert.ok(g('Senior Software Engineer', 'Paris or remote'));
  assert.ok(g('Software Engineer', 'Toronto, ON; North America'));
  assert.ok(g('Backend Engineer - Growth *EU/UK', 'Remote'));
  assert.ok(g('Full Stack Engineer', 'Latin America - Remote'));
  assert.ok(!g('Software Engineer', 'Remote'));
  assert.ok(!g('Software Engineer', 'Remote (United States)'));
  assert.ok(!g('Software Engineer', 'London, UK or Remote - US'));
});

test('title negatives in the scorer gate match whole words, like the scan', () => {
  const opts = { jobLocation: 'Remote', extraction: null, negative: ['Intern'], allowed: ['Remote'], excluded: [] };
  assert.ok(!gate({ title: 'Software Engineer, Internal Tools', ...opts }).gated);
  assert.ok(gate({ title: 'Software Engineer Intern', ...opts }).gated);
});

/* ---------------------------------------------------------------- picks ---- */

function picksDb() {
  const db = openDb(':memory:');
  attachApplications(db, null);
  const addJob = (id, score, { gated = null, lastSeen = '2026-09-24' } = {}) => {
    db.prepare("INSERT INTO jobs (id, url, url_key, title, company, first_seen, last_seen) VALUES (?, ?, ?, ?, 'Co', '2026-09-20', ?)")
      .run(id, `https://x.test/${id}`, `k${id}`, `Job ${id}`, lastSeen);
    db.prepare('INSERT INTO scores (job_id, score, matched, breakdown_json, created_at) VALUES (?, ?, 0, ?, ?)')
      .run(id, score, JSON.stringify({ gate: gated, matched_keywords: ['Python'] }), '2026-09-24');
  };
  return { db, addJob };
}

test('picks take the best by score, above the floor, up to the cap', () => {
  const { db, addJob } = picksDb();
  [70, 60, 55, 45, 39].forEach((s, i) => addJob(i + 1, s));
  const r = selectPicks(db, { date: '2026-09-24', dailyN: 3, minScore: 40, maxAgeDays: 7 });
  assert.equal(r.picked, 3);
  const ranked = db.prepare('SELECT job_id, rank FROM daily_picks ORDER BY rank').all();
  assert.deepEqual(ranked.map((x) => x.job_id), [1, 2, 3]);
});

test('picks skip gated, stale, applied and previously picked jobs', () => {
  const { db, addJob } = picksDb();
  addJob(1, 90, { gated: 'Location outside target (DNK)' });
  addJob(2, 85, { lastSeen: '2026-09-01' }); // closed: not seen on its board for weeks
  addJob(3, 80);
  addJob(4, 75);
  addJob(5, 70);
  db.prepare("INSERT INTO apps.applications (job_id, status) VALUES (3, 'submitted')").run();
  db.prepare("INSERT INTO daily_picks (pick_date, job_id, rank, score) VALUES ('2026-09-23', 4, 1, 75)").run();
  selectPicks(db, { date: '2026-09-24', dailyN: 10, minScore: 40, maxAgeDays: 7 });
  const today = db.prepare("SELECT job_id FROM daily_picks WHERE pick_date = '2026-09-24'").all();
  assert.deepEqual(today.map((x) => x.job_id), [5]);
});

test('each run is its own batch; a retry of the same run picks nothing new', () => {
  const { db, addJob } = picksDb();
  [70, 65, 60].forEach((sc, i) => addJob(i + 1, sc));
  const opts = { date: '2026-09-25', perRun: 1, minScore: 40, maxAgeDays: 7 };
  const first = selectPicks(db, { ...opts, batch: 'orion-run-a' });
  assert.equal(first.picked, 1);
  // Cloud Run retries share an execution name: same batch, no second set.
  const retry = selectPicks(db, { ...opts, batch: 'orion-run-a' });
  assert.deepEqual([retry.picked, retry.existing], [0, 1]);
  // An on-demand run the same day is a new batch and gets the next job.
  const onDemand = selectPicks(db, { ...opts, batch: 'orion-run-b' });
  assert.equal(onDemand.picked, 1);
  assert.deepEqual(db.prepare('SELECT job_id FROM daily_picks ORDER BY created_at, rank').all().map((r) => r.job_id).sort(), [1, 2]);
});

test('a role posted once per location is picked once, today and later', () => {
  const { db } = picksDb();
  const add = (id, company, title, score) => {
    db.prepare("INSERT INTO jobs (id, url, url_key, title, company, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, '2026-09-20', '2026-09-24')")
      .run(id, `https://x.test/${id}`, `k${id}`, title, company);
    db.prepare("INSERT INTO scores (job_id, score, matched, breakdown_json, created_at) VALUES (?, ?, 0, '{}', '2026-09-24')").run(id, score);
  };
  add(1, 'Truelogic', 'Senior Full Stack Engineer', 72.2);
  add(2, 'Truelogic', 'Senior  Full Stack Engineer', 72.2); // same role, other city
  add(3, 'Clera', 'AI Engineer', 70);
  selectPicks(db, { date: '2026-09-24', dailyN: 10, minScore: 40, maxAgeDays: 7 });
  assert.deepEqual(db.prepare('SELECT job_id FROM daily_picks ORDER BY rank').all().map((r) => r.job_id), [1, 3]);
  add(4, 'truelogic', 'Senior Full Stack Engineer', 80); // reposted tomorrow
  selectPicks(db, { date: '2026-09-25', dailyN: 10, minScore: 40, maxAgeDays: 7 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM daily_picks WHERE pick_date = '2026-09-25'").get().n, 0);
});

/* ---------------------------------------------------------------- sheet ---- */

test('sheet rows follow the header contract and leave status for the user', () => {
  const { db, addJob } = picksDb();
  addJob(1, 70);
  selectPicks(db, { date: '2026-09-24', dailyN: 5, minScore: 40, maxAgeDays: 7 });
  const [row] = pickRows(db, '2026-09-24');
  assert.equal(row.length, HEADER.length);
  const cell = (name) => row[HEADER.indexOf(name)];
  assert.equal(cell('pick_date'), '2026-09-24');
  assert.equal(cell('rank'), 1);
  assert.equal(cell('matched_skills'), 'Python');
  assert.equal(cell('status'), '');
});

/* ------------------------------------------------------------- import ---- */

test('junk boards are dropped without catching real employers', () => {
  for (const junk of ['test1', 'wekatest', 'mergeapiintegrationsandbox', 'optiverprivate',
    'jshiddenevents', 'mthreerecruitingportal', 'superiorexecutiveandlegalrecruiting']) {
    assert.ok(JUNK_BOARD.test(junk), junk);
  }
  // Real companies whose names contain the same words.
  for (const real of ['sandboxaq', 'hiddenlayer', 'privateer', 'anthropic', 'testifysec']) {
    assert.ok(!JUNK_BOARD.test(real), real);
  }
});

test('the sheet appends picks it does not have yet, by job id, in batch order', () => {
  const { db, addJob } = picksDb();
  [80, 70, 60].forEach((sc, i) => addJob(i + 1, sc));
  selectPicks(db, { date: '2026-09-25', batch: 'a', perRun: 2, minScore: 40, maxAgeDays: 7, now: '2026-09-25T10:00:00Z' });
  selectPicks(db, { date: '2026-09-25', batch: 'b', perRun: 2, minScore: 40, maxAgeDays: 7, now: '2026-09-25T22:00:00Z' });
  const rows = recentPickRows(db, '2026-09-20');
  const idCol = HEADER.indexOf('job_id');
  assert.deepEqual(rows.map((r) => r[idCol]), [1, 2, 3]);
  // Job 1 is already in the sheet (e.g. the earlier run succeeded); 2 and 3 are appended.
  const sheet = [HEADER, rows[0]];
  assert.deepEqual(rowsNotInSheet(rows, sheet).map((r) => r[idCol]), [2, 3]);
  assert.deepEqual(rowsNotInSheet(rows, [HEADER, ...rows]), []);
  assert.equal(rowsNotInSheet(rows, []).length, 3);
});

/* ---------------------------------------------------------- eligibility ---- */

test('citizenship and clearance requirements are recognised as written in real postings', () => {
  for (const text of [
    'ITAR Requirements: To conform to U.S. Government export regulations, applicant must be a (i) U.S. citizen',
    'U.S. Citizen and eligible for DoD Secret or TS/SCI clearance',
    'access to export-controlled information or items that require \u201cU.S. Person\u201d status',
    'Ability to obtain and maintain a U.S. Government security clearance.',
    'Requires an active TS/SCI with a polygraph. You must be a US citizen for consideration.',
    'Must be a U.S.A. citizen'
  ]) assert.ok(requiresCitizenship(text), text);
});

test('mentions of export control, security or citizens are not requirements', () => {
  for (const text of [
    'We work with export-controlled customers.',
    'Applicant must be a strong communicator.',
    'Visa sponsorship available.',
    'You will secure our clearance house APIs',
    'US-based remote role; citizens and permanent residents welcome',
    'Our U.S. team maintains high security. Clearance of backlog is a priority.'
  ]) assert.ok(!requiresCitizenship(text), text);
});

test('the citizenship gate applies only when switched on', () => {
  const job = { title: 'Software Engineer', jobLocation: 'Hawthorne, CA', extraction: null, allowed: ['US'], excluded: [],
    text: 'ITAR Requirements: applicant must be a U.S. citizen' };
  assert.equal(gate({ ...job, excludeCitizenship: true }).reason, 'Requires US citizenship or security clearance');
  assert.equal(gate(job).gated, false);
});

test('staffing agencies and job boards are recognised, real employers are not', () => {
  for (const n of ['Collabera', 'krg technology inc', 'Procom Services', 'Huzzle', 'Ginas Tech Jobs', 'Flatgigs',
    'Next Step Systems', 'Attain Talent', 'LinkedIn Job Wrapping', 'Third-Party Job Posts', 'DICE']) {
    assert.ok(isStaffingAgency(n), n);
  }
  for (const n of ['ZipRecruiter', 'Rubrik Job Board', 'Nextdoor, Inc.', 'DataVisor', 'RunSybil', 'nextdoor-jobs',
    'ServiceNow', 'LinkedIn', 'Talentsoft', 'Sony Music Global Job Board']) {
    assert.ok(!isStaffingAgency(n), n);
  }
});

test('slug-only company names are tidied, real names kept', () => {
  assert.equal(prettyName('coperniq'), 'Coperniq');
  assert.equal(prettyName('red-hat'), 'Red Hat');
  assert.equal(prettyName('ATOMS Careers page'), 'ATOMS Careers page');
});
