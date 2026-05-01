import { chromium } from 'playwright';
import { loadConfig } from './config.mjs';
import { openDb } from './db.mjs';
import { nowIsoDate } from './utils.mjs';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.mjs';

function inferPlatform(url) {
  if (url.includes('greenhouse.io')) return 'greenhouse';
  if (url.includes('lever.co')) return 'lever';
  if (url.includes('ashbyhq.com')) return 'ashby';
  return 'generic';
}

function parseTitleCompany(titleText) {
  if (!titleText) return { title: null, company: null };
  const patterns = [
    /\s+at\s+/i,
    /\s+@\s+/i,
    /\s+\|\s+/,
    /\s+—\s+/,
    /\s+-\s+/
  ];
  for (const pattern of patterns) {
    const parts = titleText.split(pattern);
    if (parts.length >= 2) {
      return { title: parts[0].trim(), company: parts[1].trim() };
    }
  }
  return { title: titleText.trim(), company: null };
}

function greenhouseSlug(url) {
  const match = url.match(/greenhouse\.io\/(.+?)(?:\/|$)/);
  return match ? match[1] : null;
}

function leverSlug(url) {
  const match = url.match(/lever\.co\/(.+?)(?:\/|$)/);
  return match ? match[1] : null;
}

async function fetchGreenhouseJobs(careersUrl) {
  const slug = greenhouseSlug(careersUrl);
  if (!slug) return [];
  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
  const res = await fetch(apiUrl);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.jobs || []).map((job) => ({
    url: job.absolute_url,
    title: job.title,
    location: job.location?.name || null,
    source: 'greenhouse'
  }));
}

async function fetchLeverJobs(careersUrl) {
  const slug = leverSlug(careersUrl);
  if (!slug) return [];
  const apiUrl = `https://api.lever.co/v0/postings/${slug}?mode=json`;
  const res = await fetch(apiUrl);
  if (!res.ok) return [];
  const data = await res.json();
  return (data || []).map((job) => ({
    url: job.hostedUrl || job.applyUrl,
    title: job.text || job.title,
    location: job.categories?.location || null,
    source: 'lever'
  })).filter((j) => j.url);
}

async function scrapeGenericJobs(careersUrl, logger) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: false });
  const page = await context.newPage();
  page.on('download', (download) => {
    if (logger) logger.warn(`Download triggered, skipping: ${careersUrl}`);
    download.cancel().catch(() => {});
  });
  try {
    await page.goto(careersUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (err) {
    if (logger) logger.warn(`Failed to load ${careersUrl}: ${err?.name || 'error'}`);
    await browser.close();
    return [];
  }
  await page.waitForTimeout(1500);
  const origin = new URL(careersUrl).origin;
  const links = await page.$$eval('a', (anchors) => anchors.map((a) => ({
    href: a.getAttribute('href'),
    text: (a.textContent || '').trim()
  })));
  await browser.close();

  const jobs = [];
  for (const link of links) {
    if (!link.href) continue;
    let url;
    try {
      url = new URL(link.href, careersUrl).toString();
    } catch {
      continue;
    }
    if (!url.startsWith(origin)) continue;
    if (!/\/(job|jobs|careers|positions)\//i.test(url)) continue;
    const title = link.text || null;
    jobs.push({ url, title, location: null, source: 'generic' });
  }

  const unique = new Map();
  for (const job of jobs) {
    if (!unique.has(job.url)) unique.set(job.url, job);
  }
  return Array.from(unique.values());
}

function decodeDuckDuckGoUrl(url) {
  try {
    const parsed = new URL(url);
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
  } catch {
    return url;
  }
  return url;
}

function parseDuckDuckGoResults(html, maxResults) {
  const results = [];
  const linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/g;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    const title = match[2].replace(/<[^>]+>/g, '').trim();
    const url = decodeDuckDuckGoUrl(href);
    results.push({ title, url });
    if (results.length >= maxResults) break;
  }
  return results;
}

async function fetchDuckDuckGoResults(query, maxResults, logger) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'minimal-job-scanner/1.0' }
    });
    if (!res.ok) {
      if (logger) logger.warn(`Search fetch failed ${res.status} for ${url}`);
      return [];
    }
    const html = await res.text();
    if (logger && !html.includes('result__a')) {
      logger.warn('Search HTML did not include result__a markers (possible markup change or block)');
    }
    return parseDuckDuckGoResults(html, maxResults);
  } catch (err) {
    if (logger) logger.warn(`Search fetch error: ${err?.message || 'unknown error'}`);
    return [];
  }
}

async function fetchSearxngResults(baseUrl, query, maxResults, logger) {
  const url = `${baseUrl.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json&language=en&categories=general`;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'minimal-job-scanner/1.0' }
    });
    if (!res.ok) {
      if (logger) logger.warn(`SearxNG fetch failed ${res.status} for ${url}`);
      return [];
    }
    const data = await res.json();
    const results = (data.results || []).map((r) => ({
      title: r.title || '',
      url: r.url || ''
    })).filter((r) => r.url);
    return results.slice(0, maxResults);
  } catch (err) {
    if (logger) logger.warn(`SearxNG fetch error: ${err?.message || 'unknown error'}`);
    return [];
  }
}

async function verifySearchResult(url, minText) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1000);
    const text = await page.evaluate(() => document.body.innerText || '');
    await browser.close();
    return text.replace(/\s+/g, ' ').trim().length >= minText;
  } catch {
    await browser.close();
    return false;
  }
}

function upsertJob(db, job, company) {
  const now = nowIsoDate();
  const existing = db.prepare('SELECT id FROM jobs WHERE url = ?').get(job.url);
  if (existing) {
    db.prepare('UPDATE jobs SET last_seen = ? WHERE id = ?').run(now, existing.id);
    return { id: existing.id, isNew: false };
  }
  const info = db.prepare(`
    INSERT INTO jobs (url, company, title, location, source, first_seen, last_seen, raw_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(job.url, company, job.title, job.location, job.source, now, now, null);
  return { id: info.lastInsertRowid, isNew: true };
}

async function main() {
  const { config, portals, paths } = loadConfig();
  const db = openDb(paths.db);
  const logger = createLogger(paths.outputDir, 'scan');
  logger.info('Scan started');
  const companies = portals.tracked_companies || [];
  const enabledCompanies = companies.filter((c) => c.enabled !== false && c.careers_url);
  let newCount = 0;
  let seenCount = 0;

  for (const company of enabledCompanies) {
    const name = company.name || company.company || company.slug || 'Unknown';
    const careersUrl = company.careers_url;
    const platform = company.platform || inferPlatform(careersUrl);
    logger.info(`Scanning ${name} (${platform}) ${careersUrl}`);
    let jobs = [];

    if (platform === 'greenhouse') {
      jobs = await fetchGreenhouseJobs(careersUrl);
    } else if (platform === 'lever') {
      jobs = await fetchLeverJobs(careersUrl);
    } else {
      jobs = await scrapeGenericJobs(careersUrl, logger);
    }
    logger.info(`Found ${jobs.length} jobs for ${name}`);

    for (const job of jobs) {
      const { isNew } = upsertJob(db, job, name);
      if (isNew) newCount += 1;
      else seenCount += 1;
    }
  }

  if (config.scan?.use_search_queries) {
    const queries = portals.search_queries || [];
    const enabledQueries = queries.filter((q) => q.enabled !== false);
    const maxResults = config.scan?.search_max_results ?? 20;
    const verify = config.scan?.verify_search_results ?? true;
    const minText = config.scan?.verify_min_text ?? 300;

    for (const q of enabledQueries) {
      const queryText = q.query || q.scan_query;
      if (!queryText) continue;
      const name = q.name || 'Search Query';
      logger.info(`Search query: ${name}`);
      let results = [];
      const provider = config.scan?.search_provider || 'duckduckgo';
      if (provider === 'searxng') {
        results = await fetchSearxngResults(config.scan?.searxng_url || 'http://localhost:8080', queryText, maxResults, logger);
      } else if (provider === 'duckduckgo') {
        results = await fetchDuckDuckGoResults(queryText, maxResults, logger);
      }
      if (results.length === 0) {
        logger.warn(`Search results: 0 for ${name} (provider may be blocked or HTML changed)`);
      } else {
        logger.info(`Search results: ${results.length} for ${name}`);
      }

      for (const result of results) {
        const shouldAdd = verify ? await verifySearchResult(result.url, minText) : true;
        if (!shouldAdd) continue;
        const parsed = parseTitleCompany(result.title);
        const job = {
          url: result.url,
          title: parsed.title,
          location: null,
          source: `search:${name}`
        };
        const { isNew } = upsertJob(db, job, parsed.company || q.company || q.name || 'Unknown');
        if (isNew) newCount += 1;
        else seenCount += 1;
      }
    }
  }

  const counts = { new: newCount, existing: seenCount, companies: enabledCompanies.length };
  db.prepare('INSERT INTO runs (run_date, stage, counts_json, duration_ms) VALUES (?, ?, ?, ?)')
    .run(nowIsoDate(), 'scan', JSON.stringify(counts), 0);

  writeFileSync(path.join(paths.outputDir, 'last-scan.json'), JSON.stringify(counts, null, 2));
  logger.info(`Scan finished new=${newCount} existing=${seenCount}`);
  logger.info(`Log file: ${logger.path}`);
  console.log(JSON.stringify(counts, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
