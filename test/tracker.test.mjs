import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.mjs';
import { normalizeStatus, syncStatuses } from '../src/tracker.mjs';

test('free-text statuses from the first sheet map to the dropdown vocabulary', () => {
  // The three values actually typed before the dropdown worked.
  assert.equal(normalizeStatus('applied'), 'Applied');
  assert.equal(normalizeStatus('not available'), 'Not available');
  assert.equal(normalizeStatus('US Citizen'), 'Ineligible');
  // Dropdown values map to themselves.
  for (const v of ['Applied', 'Skipped', 'Interview', 'Rejected', 'Offer', 'Not available', 'Ineligible']) {
    assert.equal(normalizeStatus(v), v);
  }
  assert.equal(normalizeStatus('phone screen booked'), 'Interview');
  assert.equal(normalizeStatus('position closed'), 'Not available');
  assert.equal(normalizeStatus('  '), null);
  assert.equal(normalizeStatus('maybe later'), 'Other');
});

function db() {
  const d = openDb(':memory:');
  for (const id of [1, 2, 3]) d.prepare('INSERT INTO jobs (id, url) VALUES (?, ?)').run(id, `https://x.test/${id}`);
  return d;
}

test('sync inserts marks, keeps the original text, and skips unknown jobs', () => {
  const d = db();
  const r = syncStatuses(d, [
    { job_id: '1', raw_status: 'applied', notes: '', pick_date: '2026-09-24' },
    { job_id: '2', raw_status: 'US Citizen', notes: 'ITAR', pick_date: '2026-09-24' },
    { job_id: '3', raw_status: '', notes: '', pick_date: '2026-09-24' },
    { job_id: '999', raw_status: 'applied', notes: '', pick_date: '2026-09-24' }
  ], '2026-09-25T00:00:00Z');
  assert.equal(r.inserted, 2);
  assert.equal(r.unknown_job, 1);
  const row = d.prepare('SELECT status, raw_status, notes FROM tracker_status WHERE job_id = 2').get();
  assert.deepEqual({ ...row }, { status: 'Ineligible', raw_status: 'US Citizen', notes: 'ITAR' });
});

test('updated_at moves only on a real change, and a cleared status is removed', () => {
  const d = db();
  syncStatuses(d, [{ job_id: 1, raw_status: 'applied' }], '2026-09-25T00:00:00Z');
  let r = syncStatuses(d, [{ job_id: 1, raw_status: 'applied' }], '2026-09-26T00:00:00Z');
  assert.equal(r.unchanged, 1);
  assert.equal(d.prepare('SELECT updated_at FROM tracker_status WHERE job_id = 1').get().updated_at, '2026-09-25T00:00:00Z');
  r = syncStatuses(d, [{ job_id: 1, raw_status: 'Interview' }], '2026-09-27T00:00:00Z');
  assert.equal(r.updated, 1);
  assert.equal(d.prepare('SELECT status FROM tracker_status WHERE job_id = 1').get().status, 'Interview');
  r = syncStatuses(d, [{ job_id: 1, raw_status: '' }], '2026-09-28T00:00:00Z');
  assert.equal(r.cleared, 1);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM tracker_status').get().n, 0);
});
