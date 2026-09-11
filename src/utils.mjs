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
  if (negative.some((n) => t.includes(n.toLowerCase()))) return false;
  if (positive.length && !positive.some((p) => t.includes(p.toLowerCase()))) return false;
  return true;
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

  const hostAtCapacity = (host) => (inFlightByHost.get(host) ?? 0) >= perHost;

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
