import crypto from 'node:crypto';

export function nowIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Coarse title gate shared by scan (skip ingest) and extract (skip the Gemini
 * call). Rejects a title that hits a negative keyword, or — when a positive
 * list is configured — that matches none of the positives. Empty lists mean no
 * filtering. Mirrors the scoring-time matchTitle() in score.mjs.
 */
export function titleAllowed(title, positive = [], negative = []) {
  const t = (title || '').toLowerCase();
  if (negativeHit(title, negative)) return false;
  if (positive.length && !positive.some((p) => t.includes(p.toLowerCase()))) return false;
  return true;
}

/**
 * Negatives match whole words. As substrings, "Intern" rejected every
 * "Internal Tools" role, "Crypto" every "Cryptography" one, and "SAP" anything
 * containing "sap". A hyphen counts as part of the word, so "Sales" still
 * rejects "Sales Engineer" but no longer rejects "Pre-Sales Solutions Engineer".
 */
/** The first negative term the title contains as a whole word, or undefined. */
export function negativeHit(title, negative = []) {
  const t = (title || '').toLowerCase();
  return negative.find((n) => negativeRe(n).test(t));
}

const negativeCache = new Map();
function negativeRe(term) {
  let re = negativeCache.get(term);
  if (!re) {
    const body = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(`(?<![a-z0-9-])${body}(?![a-z0-9-])`);
    negativeCache.set(term, re);
  }
  return re;
}

export function sha1(input) {
  return crypto.createHash('sha1').update(input).digest('hex');
}

export function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

export function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function extractJsonBlock(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  return match[0];
}

/** Hostname of a URL, or '' if it will not parse. Used to throttle per site. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Run `worker` over `items` with at most `limit` tasks in flight globally and at
 * most `perHost` in flight against any single hostname.
 *
 * The per-host cap matters: the pipeline hits a handful of domains (Greenhouse,
 * Lever) thousands of times, and a purely global limit would aim all of its
 * concurrency at one host and get the IP blocked.
 *
 * Workers never reject — a failing item resolves as { ok: false, error } so one
 * bad page cannot abort the batch. `shouldStop` is polled before each item is
 * started, which is how the total time budget takes effect.
 */
export async function pooled(items, worker, { limit = 4, perHost = 2, shouldStop } = {}) {
  const results = new Array(items.length);
  const inFlightByHost = new Map();
  let cursor = 0;
  let stopped = false;

  // `perHost` may be a function of the host, so a few API hosts built for
  // bulk reads can take more concurrency than arbitrary career sites.
  const capFor = typeof perHost === 'function' ? perHost : () => perHost;
  const hostAtCapacity = (host) => (inFlightByHost.get(host) ?? 0) >= capFor(host);

  async function runner() {
    for (;;) {
      if (stopped) return;
      if (shouldStop && shouldStop()) {
        stopped = true;
        return;
      }

      // Anything already claimed never needs rescanning, so the cursor may move
      // past it. Doing this every iteration (not only when claiming) is what
      // lets the pool terminate once the last items are all in flight.
      while (cursor < items.length && results[cursor] !== undefined) cursor += 1;

      // Find the next item whose host has spare capacity; skipping a blocked
      // host rather than waiting on it keeps the pool from stalling behind one
      // saturated domain.
      let index = -1;
      for (let i = cursor; i < items.length; i += 1) {
        if (results[i] !== undefined) continue;
        if (!hostAtCapacity(hostOf(items[i].url ?? items[i]))) {
          index = i;
          break;
        }
      }
      if (index === -1) {
        if (cursor >= items.length) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }

      results[index] = null; // claim the slot before awaiting

      const host = hostOf(items[index].url ?? items[index]);
      inFlightByHost.set(host, (inFlightByHost.get(host) ?? 0) + 1);
      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      } finally {
        const remaining = (inFlightByHost.get(host) ?? 1) - 1;
        if (remaining <= 0) inFlightByHost.delete(host);
        else inFlightByHost.set(host, remaining);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, limit) }, runner));
  return results;
}

// Query parameters that only record where a click came from. Everything else
// is kept: some boards carry the job id in the query (`?gh_jid=123`).
const TRACKING_PARAM = /^(utm_|gh_src$|source$|src$|ref$|lever-|ashby_)/i;

/**
 * Identity key for a posting URL, used for dedup across sources.
 *
 * The same Greenhouse job is linked as boards.greenhouse.io/… by aggregators
 * and as job-boards.greenhouse.io/… by the board API; tracking parameters and a
 * trailing slash differ too. Without folding these together, every aggregator
 * would re-insert jobs Orion already holds as new.
 */
export function canonicalUrl(url) {
  let u;
  try {
    u = new URL(String(url).trim());
  } catch {
    return String(url ?? '').trim();
  }
  let host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'job-boards.greenhouse.io') host = 'boards.greenhouse.io';
  if (host === 'job-boards.eu.greenhouse.io') host = 'boards.eu.greenhouse.io';
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAM.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  const pathname = u.pathname.replace(/\/+$/, '') || '/';
  return `https://${host}${pathname}${query}`;
}

// Bump when jobKey's rules change; openDb re-keys every row on a mismatch.
export const JOB_KEY_VERSION = 2;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * Identity of a posting across every source that links to it.
 *
 * URLs alone are not enough: the same Greenhouse job is linked as
 * boards.greenhouse.io/okta/jobs/8220634 by an aggregator and as
 * okta.com/…/8220634?gh_jid=8220634 by Okta's own board. When the URL carries
 * an ATS job id — Greenhouse ids are global integers, Ashby and Lever use UUIDs
 * — that id is the key. Anything else falls back to the canonical URL.
 */
export function jobKey(url) {
  let u;
  try {
    u = new URL(String(url).trim());
  } catch {
    return canonicalUrl(url);
  }
  const host = u.hostname.toLowerCase();
  const gh = u.searchParams.get('gh_jid');
  if (gh && /^\d+$/.test(gh)) return `gh:${gh}`;
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const m = u.pathname.match(/\/jobs\/(\d+)/);
    if (m) return `gh:${m[1]}`;
  }
  const ashbyParam = u.searchParams.get('ashby_jid');
  if (ashbyParam && new RegExp(`^${UUID}$`, 'i').test(ashbyParam)) return `ashby:${ashbyParam.toLowerCase()}`;
  if (/(^|\.)ashbyhq\.com$/.test(host)) {
    const m = u.pathname.match(new RegExp(UUID, 'i'));
    if (m) return `ashby:${m[0].toLowerCase()}`;
  }
  if (/(^|\.)lever\.co$/.test(host)) {
    const m = u.pathname.match(new RegExp(UUID, 'i'));
    if (m) return `lever:${m[0].toLowerCase()}`;
  }
  return canonicalUrl(url);
}
