import { chromium } from 'playwright';
import { loadConfig } from './config.mjs';
import { openDb } from './db.mjs';
import { nowIsoDate, pooled, titleAllowed } from './utils.mjs';
import { writeFileSync } from 'node:fs';
import { htmlToText, tidyText } from './scoring/text.mjs';
import path from 'node:path';
import { createLogger } from './logger.mjs';

function inferPlatform(url) {
  if (url.includes('greenhouse.io')) return 'greenhouse';
  if (url.includes('lever.co')) return 'lever';
  if (url.includes('ashbyhq.com')) return 'ashby';
  if (url.includes('smartrecruiters.com')) return 'smartrecruiters';
  if (url.includes('workable.com')) return 'workable';
  if (url.includes('recruitee.com')) return 'recruitee';
  if (url.includes('myworkdayjobs.com')) return 'workday';
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
  // content=true adds the posting body, which keyword and semantic scoring need.
  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
  const res = await fetch(apiUrl);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.jobs || []).map((job) => ({
    url: job.absolute_url,
    title: job.title,
    location: job.location?.name || null,
    description: htmlToText(job.content) || null,
    source: 'greenhouse'
  }));
}

function leverDescription(job) {
  const lists = (job.lists || []).map((l) => `${l.text || ''}\n${htmlToText(l.content)}`);
  return tidyText([job.descriptionPlain, ...lists, job.additionalPlain].filter(Boolean).join('\n\n')) || null;
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
    description: leverDescription(job),
    source: 'lever'
  })).filter((j) => j.url);
}

function ashbySlug(url) {
  const match = url.match(/ashbyhq\.com\/([^/?#]+)/);
  return match ? match[1] : null;
}

async function fetchAshbyJobs(careersUrl) {
  const slug = ashbySlug(careersUrl);
  if (!slug) return [];
  // Public posting API — returns the same job board the hosted page renders.
  const apiUrl = `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=false`;
  const res = await fetch(apiUrl);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.jobs || []).map((job) => ({
    url: job.jobUrl || job.applyUrl,
    title: job.title,
    location: job.location || job.locationName || null,
    description: tidyText(job.descriptionPlain) || htmlToText(job.descriptionHtml) || null,
    source: 'ashby'
  })).filter((j) => j.url && j.title);
}

function smartRecruitersSlug(url) {
  // e.g. https://jobs.smartrecruiters.com/<Company>/... or careers.smartrecruiters.com/<Company>
  const match = url.match(/smartrecruiters\.com\/([^/?#]+)/);
  return match ? match[1] : null;
}

async function fetchSmartRecruitersJobs(careersUrl) {
  const slug = smartRecruitersSlug(careersUrl);
  if (!slug) return [];
  const jobs = [];
  const limit = 100;
  // Paginate: the API caps page size at 100 and reports totalFound.
  for (let offset = 0; offset < 1000; offset += limit) {
    const apiUrl = `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=${limit}&offset=${offset}`;
    const res = await fetch(apiUrl);
    if (!res.ok) break;
    const data = await res.json();
    const content = data.content || [];
    for (const job of content) {
      const city = job.location?.city || null;
      const country = job.location?.country || null;
      const loc = [city, country].filter(Boolean).join(', ') || (job.location?.remote ? 'Remote' : null);
      jobs.push({
        url: job.ref || (job.id ? `https://jobs.smartrecruiters.com/${slug}/${job.id}` : null),
        title: job.name,
        location: loc,
        source: 'smartrecruiters'
      });
    }
    if (content.length < limit) break;
  }
  return jobs.filter((j) => j.url && j.title);
}

function workableSlug(url) {
  // apply.workable.com/<slug>/ or https://<slug>.workable.com/
  const sub = url.match(/https?:\/\/([^.]+)\.workable\.com/);
  if (sub && sub[1] !== 'apply' && sub[1] !== 'www') return sub[1];
  const path = url.match(/workable\.com\/([^/?#]+)/);
  return path ? path[1] : null;
}

async function fetchWorkableJobs(careersUrl) {
  const slug = workableSlug(careersUrl);
  if (!slug) return [];
  const apiUrl = `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`;
  const res = await fetch(apiUrl);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.jobs || []).map((job) => ({
    url: job.url || job.application_url || job.shortlink,
    title: job.title,
    location: job.location?.location_str || [job.city, job.country].filter(Boolean).join(', ') || null,
    description: htmlToText(job.description) || null,
    source: 'workable'
  })).filter((j) => j.url && j.title);
}

function recruiteeSlug(url) {
  const sub = url.match(/https?:\/\/([^.]+)\.recruitee\.com/);
  return sub ? sub[1] : null;
}

async function fetchRecruiteeJobs(careersUrl) {
  const slug = recruiteeSlug(careersUrl);
  if (!slug) return [];
  const apiUrl = `https://${slug}.recruitee.com/api/offers/`;
  const res = await fetch(apiUrl);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.offers || []).map((job) => ({
    url: job.careers_url || job.careers_apply_url,
    title: job.title,
    location: job.location || [job.city, job.country].filter(Boolean).join(', ') || null,
    description: htmlToText([job.description, job.requirements].filter(Boolean).join('\n')) || null,
    source: 'recruitee'
  })).filter((j) => j.url && j.title);
}

// platform -> structured API fetcher. Platforms absent here (e.g. 'workday',
// 'generic') fall back to scrapeGenericJobs in the scan loop.
const API_FETCHERS = {
  greenhouse: fetchGreenhouseJobs,
  lever: fetchLeverJobs,
  ashby: fetchAshbyJobs,
  smartrecruiters: fetchSmartRecruitersJobs,
  workable: fetchWorkableJobs,
  recruitee: fetchRecruiteeJobs
};

async function scrapeGenericJobs(browser, careersUrl, logger, timeoutMs = 30000) {
  const context = await browser.newContext({ acceptDownloads: false });
  const page = await context.newPage();
  page.on('download', (download) => {
    if (logger) logger.warn(`Download triggered, skipping: ${careersUrl}`);
    download.cancel().catch(() => {});
  });
  let links;
  try {
    await page.goto(careersUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(1500);
    links = await page.$$eval('a', (anchors) => anchors.map((a) => ({
      href: a.getAttribute('href'),
      text: (a.textContent || '').trim()
    })));
  } catch (err) {
    if (logger) logger.warn(`Failed to load ${careersUrl}: ${err?.name || 'error'}`);
    return [];
  } finally {
    await context.close().catch(() => {});
  }
  const origin = new URL(careersUrl).origin;

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

/**
 * Google Programmable Search via the Custom Search JSON API. Replaces the
 * DuckDuckGo HTML scrape for cloud deployment. Credentials come from the
 * environment: GOOGLE_SEARCH_API_KEY (the API key) and GOOGLE_SEARCH_CX (the
 * Programmable Search Engine id).
 *
 * The API returns at most 10 results per request, so maxResults > 10 is paged
 * with the `start` parameter. Each page is one billable query: 100/day are
 * free, then $5 per 1,000. Keeping search_max_results at 10 means one request
 * per query and stays inside the free tier for this query set.
 */
async function fetchGoogleResults(query, maxResults, logger) {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const cx = process.env.GOOGLE_SEARCH_CX;
  if (!apiKey || !cx) {
    if (logger) logger.warn('GOOGLE_SEARCH_API_KEY or GOOGLE_SEARCH_CX not set; skipping google search');
    return [];
  }
  const results = [];
  const target = Math.min(maxResults, 100); // API hard-caps start at 91 (max 100 results)
  for (let start = 1; start <= target && results.length < target; start += 10) {
    const num = Math.min(10, target - results.length);
    const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}`
      + `&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(query)}&num=${num}&start=${start}`;
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'minimal-job-scanner/1.0' } });
      if (!res.ok) {
        const text = await res.text();
        if (logger) logger.warn(`Google search failed ${res.status}: ${text.slice(0, 200)}`);
        break;
      }
      const data = await res.json();
      const items = data.items || [];
      for (const item of items) {
        if (item.link) results.push({ title: item.title || '', url: item.link });
      }
      // No next page offered, or the engine returned fewer than requested.
      if (items.length < num || !data.queries?.nextPage) break;
    } catch (err) {
      if (logger) logger.warn(`Google search error: ${err?.message || 'unknown error'}`);
      break;
    }
  }
  return results.slice(0, maxResults);
}

async function verifySearchResult(browser, url, minText, timeoutMs = 30000) {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(1000);
    const text = await page.evaluate(() => document.body.innerText || '');
    return text.replace(/\s+/g, ' ').trim().length >= minText;
  } catch {
    return false;
  } finally {
    await page.close().catch(() => {});
  }
}

function upsertJob(db, job, company) {
  const now = nowIsoDate();
  const existing = db.prepare('SELECT id FROM jobs WHERE url = ?').get(job.url);
  if (existing) {
    // Refresh the stored text too: postings get edited, and jobs scanned before
    // descriptions were captured get backfilled here.
    db.prepare('UPDATE jobs SET last_seen = ?, description = COALESCE(?, description) WHERE id = ?')
      .run(now, job.description || null, existing.id);
    return { id: existing.id, isNew: false };
  }
  const info = db.prepare(`
    INSERT INTO jobs (url, company, title, location, source, first_seen, last_seen, raw_path, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(job.url, company, job.title, job.location, job.source, now, now, null, job.description || null);
  return { id: info.lastInsertRowid, isNew: true };
}

async function main() {
  const { config, portals, paths } = loadConfig();
  const db = openDb(paths.db);
  const logger = createLogger(paths.outputDir, 'scan');
  logger.info('Scan started');
  const startedAt = Date.now();

  const companies = portals.tracked_companies || [];
  const enabledCompanies = companies.filter((c) => c.enabled !== false && c.careers_url);
  const concurrency = config.scan?.concurrency ?? 4;
  const perHost = config.scan?.per_host_concurrency ?? 2;
  const pageTimeoutMs = config.scan?.page_timeout_ms ?? 30000;
  // Title pre-filter (on by default). Reuses portals.title_filter so scan and
  // score agree on what counts as a relevant title.
  const titleFilterEnabled = config.scan?.filter_by_title !== false;
  const titlePositive = portals.title_filter?.positive || [];
  const titleNegative = portals.title_filter?.negative || [];
  const passesTitle = (title) => !titleFilterEnabled || titleAllowed(title, titlePositive, titleNegative);
  let newCount = 0;
  let seenCount = 0;
  let skippedTitle = 0;

  // One browser for the whole stage. Company pages and search-result
  // verification each used to launch (and tear down) their own Chromium.
  const browser = await chromium.launch({ headless: true });

  try {
    const companyItems = enabledCompanies.map((company) => ({
      company,
      url: company.careers_url
    }));

    await pooled(companyItems, async ({ company, url: careersUrl }) => {
      const name = company.name || company.company || company.slug || 'Unknown';
      const platform = company.platform || inferPlatform(careersUrl);
      logger.info(`Scanning ${name} (${platform}) ${careersUrl}`);
      // Platforms with a structured API fetcher; anything else (including
      // Workday, deferred to a later phase) falls back to generic scraping.
      const fetcher = API_FETCHERS[platform];
      let jobs = [];
      try {
        jobs = fetcher
          ? await fetcher(careersUrl)
          : await scrapeGenericJobs(browser, careersUrl, logger, pageTimeoutMs);
      } catch (err) {
        logger.warn(`Fetch failed for ${name} (${platform}): ${err?.message || 'error'}`);
        jobs = [];
      }
      logger.info(`Found ${jobs.length} jobs for ${name}`);

      // better-sqlite3 is synchronous and there is no await inside upsertJob,
      // so these writes stay atomic with respect to the other pool workers.
      for (const job of jobs) {
        if (!passesTitle(job.title)) { skippedTitle += 1; continue; }
        const { isNew } = upsertJob(db, job, name);
        if (isNew) newCount += 1;
        else seenCount += 1;
      }
    }, { limit: concurrency, perHost });

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
        if (provider === 'google') {
          results = await fetchGoogleResults(queryText, maxResults, logger);
        } else if (provider === 'searxng') {
          results = await fetchSearxngResults(config.scan?.searxng_url || 'http://localhost:8080', queryText, maxResults, logger);
        } else if (provider === 'duckduckgo') {
          results = await fetchDuckDuckGoResults(queryText, maxResults, logger);
        }
        if (results.length === 0) {
          logger.warn(`Search results: 0 for ${name} (provider may be blocked or HTML changed)`);
          continue;
        }
        // Title-gate before the expensive verification page loads: no point
        // loading a result whose title cannot match.
        const candidates = results
          .map((result) => ({ result, parsed: parseTitleCompany(result.title) }))
          .filter(({ parsed }) => {
            if (passesTitle(parsed.title)) return true;
            skippedTitle += 1;
            return false;
          });
        logger.info(`Search results: ${results.length} for ${name} (${candidates.length} pass title filter)`);

        // Verification is the expensive part: one page load per result. Queries
        // stay serial (search providers rate-limit hard) but their results are
        // verified in parallel.
        const verdicts = await pooled(candidates, async ({ result }) => (
          verify ? verifySearchResult(browser, result.url, minText, pageTimeoutMs) : true
        ), { limit: concurrency, perHost });

        candidates.forEach(({ result, parsed }, i) => {
          const verdict = verdicts[i];
          if (!verdict || !verdict.ok || verdict.value !== true) return;
          const job = {
            url: result.url,
            title: parsed.title,
            location: null,
            source: `search:${name}`
          };
          const { isNew } = upsertJob(db, job, parsed.company || q.company || q.name || 'Unknown');
          if (isNew) newCount += 1;
          else seenCount += 1;
        });
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const durationMs = Date.now() - startedAt;
  const counts = { new: newCount, existing: seenCount, skipped_title: skippedTitle, companies: enabledCompanies.length };
  db.prepare('INSERT INTO runs (run_date, stage, counts_json, duration_ms) VALUES (?, ?, ?, ?)')
    .run(nowIsoDate(), 'scan', JSON.stringify(counts), durationMs);

  writeFileSync(path.join(paths.outputDir, 'last-scan.json'), JSON.stringify(counts, null, 2));
  logger.info(`Scan finished new=${newCount} existing=${seenCount} skipped_title=${skippedTitle} in ${Math.round(durationMs / 1000)}s`);
  logger.info(`Log file: ${logger.path}`);
  console.log(JSON.stringify(counts, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
