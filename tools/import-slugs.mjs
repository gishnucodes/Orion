#!/usr/bin/env node
/**
 * One-off: grow the board list from a public slug index, keeping only boards
 * that are live and relevant right now.
 *
 *   node tools/import-slugs.mjs [--max 3000] [--concurrency 16]
 *
 * Source: kalil0321/ats-scrapers (MIT) — company slugs harvested for
 * Greenhouse, Ashby and Lever. A slug index is not a board list: boards close,
 * rename, or never post relevant roles. So every slug is checked against its
 * live ATS API, and kept only if it has at least one posting that passes the
 * same title filter and US location gate the nightly scan applies.
 *
 * Writes portals.discovered.yml, which loadConfig merges after the curated
 * portals.yml. Re-run it monthly; it replaces the file each time.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { repoRoot } from '../src/config.mjs';
import { titleAllowed, pooled } from '../src/utils.mjs';
import { gate } from '../src/scoring/formula.mjs';

const SOURCES = {
  greenhouse: 'https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies/greenhouse.csv',
  ashby: 'https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies/ashby.csv',
  lever: 'https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies/lever.csv'
};

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const MAX = Number(arg('max', 3000));
const CONCURRENCY = Number(arg('concurrency', 16));

/** Minimal CSV row parser: quoted fields may contain commas. */
function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { cur += '"'; i += 1; } else quoted = !quoted;
      } else if (ch === ',' && !quoted) { cells.push(cur); cur = ''; } else cur += ch;
    }
    cells.push(cur);
    rows.push({ name: cells[0]?.trim(), slug: cells[1]?.trim() });
  }
  return rows.filter((r) => r.slug);
}

/** Title + location of each live posting on a board, or null if the board is gone. */
async function listJobs(platform, slug) {
  if (platform === 'greenhouse') {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
    if (!res.ok) return null;
    return ((await res.json()).jobs || []).map((j) => ({ title: j.title, location: j.location?.name }));
  }
  if (platform === 'ashby') {
    const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
    if (!res.ok) return null;
    return ((await res.json()).jobs || []).map((j) => ({ title: j.title, location: j.location || j.locationName }));
  }
  const res = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) ? data.map((j) => ({ title: j.text, location: j.categories?.location })) : null;
}

/**
 * Boards that are not an employer's real job board: ATS test/sandbox tenants,
 * private or hidden boards, and recruiting-agency portals that repost other
 * companies' roles. Seen in the index as "test1", "optiverprivate",
 * "mergeapiintegrationsandbox", "jshiddenevents", "mthreerecruitingportal".
 */
// Suffix-anchored where a real company could share the word: SandboxAQ,
// HiddenLayer and Privateer are employers, "…sandbox" and "…private" are not.
export const JUNK_BOARD = /(^test\d*$|test$|sandbox$|demo$|private$|hidden(events)?$|recruiting|recruitment|staffing|talentportal|portal$)/i;

const careersUrl = {
  greenhouse: (s) => `https://job-boards.greenhouse.io/${s}`,
  ashby: (s) => `https://jobs.ashbyhq.com/${s}`,
  lever: (s) => `https://jobs.lever.co/${s}`
};

async function main() {
  const config = yaml.load(readFileSync(path.join(repoRoot, 'config.yml'), 'utf8'));
  const portals = yaml.load(readFileSync(path.join(repoRoot, 'portals.yml'), 'utf8'));
  const positive = portals.title_filter?.positive || [];
  const negative = portals.title_filter?.negative || [];
  const allowed = config.location?.allowed || [];
  const excluded = config.location?.excluded || [];

  // Boards already curated are skipped — the curated entry wins.
  const slugOf = (u) => (u || '').match(/(?:greenhouse\.io|ashbyhq\.com|lever\.co)\/([^/?#]+)/i)?.[1]?.toLowerCase();
  const curated = new Set((portals.tracked_companies || []).map((c) => slugOf(c.careers_url)).filter(Boolean));

  const candidates = [];
  for (const [platform, url] of Object.entries(SOURCES)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${platform} slug list: HTTP ${res.status}`);
    const rows = parseCsv(await res.text());
    for (const r of rows) {
      if (curated.has(r.slug.toLowerCase()) || JUNK_BOARD.test(r.slug)) continue;
      candidates.push({ ...r, platform, url: careersUrl[platform](r.slug) });
    }
    console.log(`${platform}: ${rows.length} slugs`);
  }
  console.log(`checking ${candidates.length} boards (concurrency ${CONCURRENCY})...`);

  let done = 0;
  const started = Date.now();
  const results = await pooled(candidates, async (c) => {
    const jobs = await listJobs(c.platform, c.slug).catch(() => null);
    done += 1;
    if (done % 500 === 0) console.log(`  ${done}/${candidates.length} (${Math.round((Date.now() - started) / 1000)}s)`);
    if (!jobs) return { ...c, live: false, relevant: 0, total: 0 };
    const relevant = jobs.filter((j) => titleAllowed(j.title, positive, negative)
      && !gate({ title: j.title, jobLocation: j.location, extraction: null, allowed, excluded }).gated).length;
    return { ...c, live: true, relevant, total: jobs.length };
  }, { limit: CONCURRENCY, perHost: 8 });

  const checked = results.filter((r) => r?.ok).map((r) => r.value);
  const live = checked.filter((r) => r.live);
  const keep = live.filter((r) => r.relevant > 0).sort((a, b) => b.relevant - a.relevant).slice(0, MAX);

  const byPlatform = (list) => Object.fromEntries(['greenhouse', 'ashby', 'lever']
    .map((p) => [p, list.filter((r) => r.platform === p).length]));
  console.log(`\nlive boards: ${live.length} of ${checked.length}  ${JSON.stringify(byPlatform(live))}`);
  console.log(`with >=1 US title-relevant posting: ${live.filter((r) => r.relevant > 0).length}`);
  console.log(`keeping ${keep.length}  ${JSON.stringify(byPlatform(keep))}`);
  console.log(`relevant postings on kept boards right now: ${keep.reduce((a, r) => a + r.relevant, 0)}`);

  const header = [
    '# Boards discovered by tools/import-slugs.mjs — do not edit by hand; re-run the tool.',
    `# Generated ${new Date().toISOString().slice(0, 10)} from kalil0321/ats-scrapers (MIT License,`,
    '# Copyright (c) 2026 Kalil Bouzigues). Each board had >=1 live US, title-relevant',
    '# posting when checked. Merged after portals.yml by src/config.mjs.',
    ''
  ].join('\n');
  const doc = {
    tracked_companies: keep.map((r) => ({
      name: r.name || r.slug,
      careers_url: r.url,
      platform: r.platform,
      enabled: true
    }))
  };
  const out = path.join(repoRoot, 'portals.discovered.yml');
  writeFileSync(out, header + yaml.dump(doc, { lineWidth: 200 }));
  console.log(`wrote ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
