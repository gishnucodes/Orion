import { chromium } from 'playwright';
import { loadConfig } from './config.mjs';
import { openDb } from './db.mjs';
import { nowIsoDate, pooled, titleAllowed, jobKey } from './utils.mjs';
import { companyFromUrl } from './employer.mjs';
import { gate } from './scoring/formula.mjs';
import { writeFileSync } from 'node:fs';
import { htmlToText, tidyText } from './scoring/text.mjs';
import path from 'node:path';
import { createLogger } from './logger.mjs';

// Career-page hosts of boards read through an ATS API (see pooled's per-host cap).
const API_BOARD_HOST = /(greenhouse\.io|ashbyhq\.com|lever\.co|getro\.com|jobs\.accel\.com|jobs\.generalcatalyst\.com|jobs\.khoslaventures\.com)$/;

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

async function fetchGreenhouseDetail(slug, id) {
  const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${id}`);
  if (!res.ok) return null;
  const job = await res.json();
  return htmlToText(job.content) || null;
}

async function fetchGreenhouseJobs(careersUrl) {
  const slug = greenhouseSlug(careersUrl);
  if (!slug) return [];
  // No content=true: across thousands of boards the full bodies are hundreds of
  // MB a night, nearly all for jobs already stored. The body is fetched per job
  // (`describe`) only for postings that are new and pass the title filter.
  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
  const res = await fetch(apiUrl);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.jobs || []).map((job) => ({
    url: job.absolute_url,
    title: job.title,
    location: job.location?.name || null,
    description: null,
    describe: () => fetchGreenhouseDetail(slug, job.id),
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

async function fetchLeverDetail(slug, id) {
  const res = await fetch(`https://api.lever.co/v0/postings/${slug}/${id}`);
  if (!res.ok) return null;
  return leverDescription(await res.json());
}

/** Load the body of an aggregator's posting straight from its ATS, when the ATS allows it. */
function describeFromUrl(url) {
  const gh = url.match(/(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
  if (gh) return () => fetchGreenhouseDetail(gh[1], gh[2]);
  const lv = url.match(/jobs\.lever\.co\/([^/]+)\/([0-9a-f-]{36})/);
  if (lv) return () => fetchLeverDetail(lv[1], lv[2]);
  // Anything else (Workday, career sites) is page-fetched by the extract stage.
  return null;
}

/**
 * Getro powers many VC portfolio boards (Accel, General Catalyst, Khosla…). Its
 * search API needs `accept: application/json` — without it the API answers 406,
 * which is why scraping these boards returned nothing. Results come newest
 * first; paging stops once a page reaches postings older than `max_age_hours`,
 * so a nightly run reads only the recent slice of a 20,000-job network.
 */
async function fetchGetroJobs(careersUrl, company = {}) {
  const networkId = company.network_id;
  if (!networkId) return [];
  const maxAgeSec = (company.max_age_hours ?? 48) * 3600;
  const maxPages = company.max_pages ?? 60;
  const now = Date.now() / 1000;
  const out = [];
  for (let page = 0; page < maxPages; page += 1) {
    const res = await fetch(`https://api.getro.com/api/v2/collections/${networkId}/search/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'Mozilla/5.0 (orion job scanner)' },
      body: JSON.stringify({ hitsPerPage: 20, page, filters: '', query: company.query ?? '' })
    });
    if (!res.ok) break;
    const jobs = (await res.json()).results?.jobs || [];
    if (!jobs.length) break;
    for (const job of jobs) {
      if (!job.url || !job.title) continue;
      if (now - (job.created_at ?? 0) > maxAgeSec) continue;
      const locations = [...new Set(job.searchable_locations || [])];
      out.push({
        url: job.url,
        title: job.title,
        location: locations.join('; ') || null,
        description: null,
        describe: describeFromUrl(job.url),
        company: companyFromUrl(job.url, job.organization?.name),
        source: `getro:${company.name || networkId}`
      });
    }
    const oldest = Math.min(...jobs.map((j) => j.created_at ?? 0));
    if (now - oldest > maxAgeSec) break;
  }
  return out;
}

// platform -> structured API fetcher. Platforms absent here (e.g. 'workday',
// 'generic') fall back to scrapeGenericJobs in the scan loop.
const API_FETCHERS = {
  greenhouse: fetchGreenhouseJobs,
  lever: fetchLeverJobs,
  ashby: fetchAshbyJobs,
  smartrecruiters: fetchSmartRecruitersJobs,
  workable: fetchWorkableJobs,
  recruitee: fetchRecruiteeJobs,
  getro: fetchGetroJobs
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

/** The stored job for a URL, matched on its identity key so aggregator links dedupe. */
function findJob(db, url) {
  return db.prepare('SELECT id FROM jobs WHERE url_key = ? OR url = ?').get(jobKey(url), url);
}

function upsertJob(db, job, company) {
  const now = nowIsoDate();
  const existing = findJob(db, job.url);
  if (existing) {
    // Refresh the stored text too: postings get edited, and jobs scanned before
    // descriptions were captured get backfilled here. An aggregator may also
    // know a location the board API left blank.
    db.prepare(`UPDATE jobs SET last_seen = ?, description = COALESCE(?, description),
                location = COALESCE(location, ?) WHERE id = ?`)
      .run(now, job.description || null, job.location || null, existing.id);
    return { id: existing.id, isNew: false };
  }
  const info = db.prepare(`
    INSERT INTO jobs (url, url_key, company, title, location, source, first_seen, last_seen, raw_path, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(job.url, jobKey(job.url), company, job.title, job.location, job.source, now, now, null, job.description || null);
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
  // Location pre-filter, using the scorer's own gate so scan and score agree.
  // Without it, foreign-only postings (a fifth of aggregator results) were
  // page-fetched and sent to the model before score.mjs discarded them. Only
  // an explicitly foreign location is dropped; unknown locations pass.
  const locationFilterEnabled = config.scan?.filter_by_location !== false;
  const allowedPlaces = config.location?.allowed || [];
  const excludedPlaces = config.location?.excluded || [];
  const foreignOnly = (job) => locationFilterEnabled
    && gate({ title: job.title, jobLocation: job.location, extraction: null, allowed: allowedPlaces, excluded: excludedPlaces }).gated;
  const apiPerHost = config.scan?.api_per_host_concurrency ?? 8;
  let newCount = 0;
  let seenCount = 0;
  let skippedTitle = 0;
  let described = 0;
  // Cap on in-flight description requests across all boards (see the scan loop).
  const describeLimit = config.scan?.describe_concurrency ?? 16;
  let describing = 0;
  const describeQueue = [];
  const withDescribeSlot = async (fn) => {
    while (describing >= describeLimit) await new Promise((resolve) => describeQueue.push(resolve));
    describing += 1;
    try {
      return await fn();
    } finally {
      describing -= 1;
      describeQueue.shift()?.();
    }
  };
  let skippedLocation = 0;
  const newBySource = {};

  // One browser for the whole stage. Company pages and search-result
  // verification each used to launch (and tear down) their own Chromium.
  // Launched on first use. Most boards are read through ATS APIs and never
  // need it; launching up front meant a missing or broken Chromium failed the
  // whole scan, API boards included.
  let browserPromise = null;
  const getBrowser = () => (browserPromise ??= chromium.launch({ headless: true }));

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
          ? await fetcher(careersUrl, company)
          : await scrapeGenericJobs(await getBrowser(), careersUrl, logger, pageTimeoutMs);
      } catch (err) {
        logger.warn(`Fetch failed for ${name} (${platform}): ${err?.message || 'error'}`);
        jobs = [];
      }
      logger.info(`Found ${jobs.length} jobs for ${name}`);

      const relevant = [];
      for (const job of jobs) {
        if (!passesTitle(job.title)) skippedTitle += 1;
        else if (foreignOnly(job)) skippedLocation += 1;
        else relevant.push(job);
      }
      // Posting bodies only for jobs not stored yet — a few per board per night,
      // instead of every body on every board. Fetched in parallel under a cap
      // shared by all boards: a newly added board makes every posting "new",
      // and one at a time that stalled the scan for most of an hour.
      await Promise.all(relevant
        .filter((job) => !job.description && job.describe && !findJob(db, job.url))
        .map((job) => withDescribeSlot(async () => {
          try {
            job.description = await job.describe();
            described += 1;
          } catch {
            // Left null: the extract stage page-fetches postings without a body.
          }
        })));
      // One transaction per board. better-sqlite3 is synchronous, so the block
      // is atomic with respect to the other pool workers, and thousands of
      // last_seen updates share a commit instead of paying one each.
      db.transaction((rows) => {
        for (const job of rows) {
          const { isNew } = upsertJob(db, job, job.company || name);
          if (isNew) {
            newCount += 1;
            newBySource[platform] = (newBySource[platform] ?? 0) + 1;
          } else {
            seenCount += 1;
          }
        }
      })(relevant);
    }, {
      limit: concurrency,
      // ATS APIs are built for bulk reads; career sites get the cautious cap.
      perHost: (host) => (API_BOARD_HOST.test(host) ? apiPerHost : perHost)
    });

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
          verify ? verifySearchResult(await getBrowser(), result.url, minText, pageTimeoutMs) : true
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
    if (browserPromise) await browserPromise.then((b) => b.close()).catch(() => {});
  }

  const durationMs = Date.now() - startedAt;
  const counts = {
    new: newCount, existing: seenCount, skipped_title: skippedTitle, skipped_location: skippedLocation, described,
    new_by_source: newBySource, companies: enabledCompanies.length
  };
  db.prepare('INSERT INTO runs (run_date, stage, counts_json, duration_ms) VALUES (?, ?, ?, ?)')
    .run(nowIsoDate(), 'scan', JSON.stringify(counts), durationMs);

  writeFileSync(path.join(paths.outputDir, 'last-scan.json'), JSON.stringify(counts, null, 2));
  logger.info(`Scan finished new=${newCount} existing=${seenCount} skipped_title=${skippedTitle} skipped_location=${skippedLocation} described=${described} by_source=${JSON.stringify(newBySource)} in ${Math.round(durationMs / 1000)}s`);
  logger.info(`Log file: ${logger.path}`);
  console.log(JSON.stringify(counts, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
