import { chromium } from 'playwright';
import { loadConfig } from './config.mjs';
import { openDb } from './db.mjs';
import { extractJsonBlock, safeJsonParse, nowIsoDate, sha1, normalizeWhitespace, pooled, titleAllowed } from './utils.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createLogger } from './logger.mjs';

/**
 * Deliberately small and flat.
 *
 * The original prompt asked qwen2.5:0.5b for a 19-field nested entity graph. A
 * 0.5B model cannot hold that shape: measured over real cached postings it ran
 * ~69s per job, hit the token cap, and produced parseable JSON only 1 time in 5
 * — which is why `location` was null almost everywhere and scoring starved.
 * Asking only for the fields score.mjs actually reads brings it to ~4.5s per job
 * with 9/10 parsing, and location is populated for real.
 *
 * `liftToEntityGraph` maps the flat result back into the nested shape, so rows
 * written before this change stay readable by the same scorer.
 */
function buildPrompt(jobText) {
  return [
    'Extract job facts. Return ONLY a JSON object. No prose. No markdown.',
    'Schema:',
    '{"location": string|null, "remote": true|false|null, "seniority": string|null,',
    ' "seniority_level": "intern"|"junior"|"mid"|"senior"|"staff"|"principal"|"manager"|"director_plus"|null,',
    ' "years_experience_min": number|null,',
    ' "employment_type": string|null, "work_authorization": string|null, "visa_sponsorship": string|null,',
    ' "skills": string[], "required_skills": string[], "nice_to_have_skills": string[], "tech_stack": string[]}',
    'Rules: skills = technologies named anywhere (max 15).',
    'required_skills = technologies listed as required (max 10).',
    'nice_to_have_skills = technologies listed as preferred/bonus (max 8).',
    'tech_stack = languages/frameworks/databases/cloud tools (max 10).',
    'years_experience_min = smallest years of experience required, as a number.',
    'visa_sponsorship = "yes", "no" or null, only if the posting says so.',
    'Use null when unknown. Use [] when none.',
    '',
    'POSTING:',
    jobText,
    '',
    'JSON:'
  ].join('\n');
}

/** Expand the flat model output into the nested shape the scorer expects. */
function liftToEntityGraph(flat) {
  const base = fallbackExtract('');
  if (!flat || typeof flat !== 'object') return base;
  return {
    ...base,
    location: flat.location ?? null,
    remote: typeof flat.remote === 'boolean' ? flat.remote : null,
    seniority: flat.seniority ?? null,
    skills: Array.isArray(flat.skills) ? flat.skills : [],
    entity_graph: {
      ...base.entity_graph,
      location: flat.location ?? null,
      seniority: flat.seniority ?? null,
      seniority_level: flat.seniority_level ?? null,
      years_experience_min: typeof flat.years_experience_min === 'number' ? flat.years_experience_min : null,
      employment_type: flat.employment_type ?? null,
      work_authorization: flat.work_authorization ?? null,
      visa_sponsorship: flat.visa_sponsorship ?? null,
      required_skills: Array.isArray(flat.required_skills) ? flat.required_skills : [],
      nice_to_have_skills: Array.isArray(flat.nice_to_have_skills) ? flat.nice_to_have_skills : [],
      tech_stack: Array.isArray(flat.tech_stack) ? flat.tech_stack : []
    }
  };
}

function runLlama(runner, modelPath, params, prompt) {
  return new Promise((resolve, reject) => {
    const args = [
      '-m', modelPath,
      '-p', prompt,
      '--temp', String(params.temp ?? 0),
      '--top-p', String(params.top_p ?? 1),
      '--top-k', String(params.top_k ?? 1),
      '--seed', String(params.seed ?? 42),
      '--ctx-size', String(params.ctx ?? 4096),
      '--n-predict', '512'
    ];
    const proc = spawn(runner, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`llama.cpp exited ${code}: ${err}`));
      } else {
        resolve(out);
      }
    });
  });
}

async function runOllama(modelName, params, prompt, options = {}) {
  const body = {
    model: modelName,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    // Grammar-constrained decoding. Without it the model wraps output in a
    // markdown fence and keeps talking, which defeats extractJsonBlock.
    format: 'json',
    options: {
      temperature: params.temp ?? 0,
      top_p: params.top_p ?? 1,
      top_k: params.top_k ?? 1,
      seed: params.seed ?? 42,
      num_ctx: params.ctx ?? 4096,
      // Hard output cap. Greedy decoding on a small model can loop forever, and
      // Ollama's default is unlimited — this was the cause of multi-minute
      // stalls in the extract stage.
      num_predict: params.num_predict ?? 300
    }
  };

  // Belt and braces: even with num_predict, a wedged or swapping model can hang
  // the socket. Without this a single job could stall a pool worker all night.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60000);
  try {
    const res = await fetch(options.url ?? 'http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ollama error ${res.status}: ${text}`);
    }
    const data = await res.json();
    return data.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gemini via the Generative Language REST API. This replaces the local
 * qwen/Ollama model for cloud deployment: no model to host, ~1,700 input +
 * ~200 output tokens per job on gemini-2.0-flash-lite. The API key is read from
 * GEMINI_API_KEY (GOOGLE_API_KEY is accepted as a fallback).
 *
 * responseMimeType: 'application/json' makes the model return a bare JSON
 * object with no markdown fence, so extractJsonBlock downstream is a no-op but
 * kept for safety.
 */
async function runGemini(modelName, params, prompt, options = {}) {
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set (required for model.runner: gemini)');
  }
  const base = (options.url || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  const url = `${base}/models/${encodeURIComponent(modelName)}:generateContent`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: params.temp ?? 0,
      topP: params.top_p ?? 1,
      topK: params.top_k ?? 1,
      maxOutputTokens: params.num_predict ?? 300,
      responseMimeType: 'application/json'
    }
  };

  // Retry on rate-limit / transient errors with exponential backoff. The
  // free-tier Gemini quota is per-minute, and at concurrency > 1 a burst will
  // draw 429s; without backoff those jobs would fall back to the empty
  // extraction. 429 and 503 are retried; other statuses fail fast.
  const maxAttempts = options.maxAttempts ?? 4;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 60000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (res.ok) {
        const data = await res.json();
        const parts = data.candidates?.[0]?.content?.parts || [];
        return parts.map((p) => p.text || '').join('');
      }
      const text = await res.text();
      lastErr = new Error(`gemini error ${res.status}: ${text.slice(0, 300)}`);
      if ((res.status === 429 || res.status === 503) && attempt < maxAttempts) {
        clearTimeout(timer);
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/**
 * Takes a shared browser rather than launching its own. Spawning a Chromium
 * process per URL was the single biggest cost in this stage (~1,370 launches on
 * a cold run); one browser with a page per URL removes all of it.
 */
async function fetchJobText(browser, url, timeoutMs) {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(1500);
    const text = await page.evaluate(() => document.body.innerText || '');
    return normalizeWhitespace(text);
  } finally {
    await page.close().catch(() => {});
  }
}

function fallbackExtract(jobText) {
  return {
    title: null,
    company: null,
    location: null,
    remote: /remote/i.test(jobText) ? true : null,
    seniority: null,
    responsibilities: [],
    requirements: [],
    skills: [],
    years_experience: null,
    visa: null,
    salary: null,
    entity_graph: {
      role_title: null,
      company: null,
      location: null,
      remote_policy: null,
      seniority: null,
      seniority_level: null,
      employment_type: null,
      required_skills: [],
      nice_to_have_skills: [],
      tools: [],
      tech_stack: [],
      years_experience_min: null,
      years_experience_max: null,
      domain_keywords: [],
      product_keywords: [],
      work_authorization: null,
      visa_sponsorship: null,
      salary_range: null,
      benefits: [],
      responsibilities: []
    }
  };
}

function sanitizeEntityGraph(obj) {
  const cleanArray = (arr) =>
    Array.isArray(arr) ? arr.filter((v) => typeof v === 'string' && v.trim().length > 0) : [];
  const cleanString = (v) => (typeof v === 'string' ? v : null);
  const cleanNumber = (v) => (typeof v === 'number' ? v : null);

  if (!obj || typeof obj !== 'object') {
    return fallbackExtract('').entity_graph;
  }

  return {
    role_title: cleanString(obj.role_title),
    company: cleanString(obj.company),
    location: cleanString(obj.location),
    remote_policy: cleanString(obj.remote_policy),
    seniority: cleanString(obj.seniority),
    seniority_level: cleanString(obj.seniority_level),
    employment_type: cleanString(obj.employment_type),
    required_skills: cleanArray(obj.required_skills),
    nice_to_have_skills: cleanArray(obj.nice_to_have_skills),
    tools: cleanArray(obj.tools),
    tech_stack: cleanArray(obj.tech_stack),
    years_experience_min: cleanNumber(obj.years_experience_min),
    years_experience_max: cleanNumber(obj.years_experience_max),
    domain_keywords: cleanArray(obj.domain_keywords),
    product_keywords: cleanArray(obj.product_keywords),
    work_authorization: cleanString(obj.work_authorization),
    visa_sponsorship: cleanString(obj.visa_sponsorship),
    salary_range: cleanString(obj.salary_range),
    benefits: cleanArray(obj.benefits),
    responsibilities: cleanArray(obj.responsibilities)
  };
}

function sanitizeExtraction(obj) {
  if (!obj || typeof obj !== 'object') return fallbackExtract('');
  const cleanArray = (arr) =>
    Array.isArray(arr) ? arr.filter((v) => typeof v === 'string' && v.trim().length > 0) : [];
  return {
    title: typeof obj.title === 'string' ? obj.title : null,
    company: typeof obj.company === 'string' ? obj.company : null,
    location: typeof obj.location === 'string' ? obj.location : null,
    remote: typeof obj.remote === 'boolean' ? obj.remote : null,
    seniority: typeof obj.seniority === 'string' ? obj.seniority : null,
    responsibilities: cleanArray(obj.responsibilities),
    requirements: cleanArray(obj.requirements),
    skills: cleanArray(obj.skills),
    years_experience: typeof obj.years_experience === 'number' ? obj.years_experience : null,
    visa: typeof obj.visa === 'string' ? obj.visa : null,
    salary: typeof obj.salary === 'string' ? obj.salary : null,
    entity_graph: sanitizeEntityGraph(obj.entity_graph)
  };
}

async function main() {
  const { config, portals, paths } = loadConfig();
  const db = openDb(paths.db);
  mkdirSync(paths.rawDir, { recursive: true });
  const logger = createLogger(paths.outputDir, 'extract');
  logger.info('Extract started');

  const maxJobs = config.extract?.max_jobs ?? 100;
  // Title gate (shared with scan): never spend a Gemini call on a job whose
  // title cannot match, even one already sitting in the database from before
  // the filter existed. LIMIT is applied after filtering so max_jobs counts
  // relevant jobs, not rejects.
  const titleFilterEnabled = config.scan?.filter_by_title !== false;
  const titlePositive = portals.title_filter?.positive || [];
  const titleNegative = portals.title_filter?.negative || [];

  const candidates = db.prepare(`
    SELECT j.id, j.url, j.raw_path, j.title, j.description
    FROM jobs j
    LEFT JOIN extractions e ON e.job_id = j.id AND e.status = 'ok'
    WHERE e.id IS NULL
    ORDER BY j.id ASC
  `).all();

  let skippedTitle = 0;
  const relevant = titleFilterEnabled
    ? candidates.filter((j) => {
        if (titleAllowed(j.title, titlePositive, titleNegative)) return true;
        skippedTitle += 1;
        return false;
      })
    : candidates;
  const jobs = relevant.slice(0, maxJobs);
  logger.info(`Jobs to extract: ${jobs.length} (candidates=${candidates.length}, skipped_title=${skippedTitle})`);

  const pageTimeoutMs = config.extract?.page_timeout_ms ?? 30000;
  const totalBudgetMs = config.extract?.total_budget_ms ?? 5400000;
  const concurrency = config.extract?.concurrency ?? 4;
  const inputChars = config.extract?.input_chars ?? 6000;
  const modelTimeoutMs = config.model?.request_timeout_ms ?? 60000;
  const perHost = config.extract?.per_host_concurrency ?? 2;
  // Model can be overridden at runtime (GEMINI_MODEL) so a swap needs no rebuild.
  const geminiModel = process.env.GEMINI_MODEL || config.model.model_name;
  // Recorded in the extractions.model column. For API runners the gguf path in
  // config is meaningless, so label rows with the model name instead.
  const modelLabel = config.model.runner === 'gemini'
    ? `gemini:${geminiModel}`
    : config.model.model_path;
  const startedAt = Date.now();
  const deadline = startedAt + totalBudgetMs;

  const insertExtraction = db.prepare(
    'INSERT INTO extractions (job_id, json, model, status, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const updateRawPath = db.prepare('UPDATE jobs SET raw_path = ?, description = COALESCE(description, ?) WHERE id = ?');

  const browser = await chromium.launch({ headless: true });
  const counts = { ok: 0, fallback: 0, fetch_failed: 0 };
  let processed = 0;

  try {
    await pooled(jobs, async (job) => {
      let rawPath = job.raw_path;
      let jobText = null;
      logger.info(`Job ${job.id} fetch ${job.url}`);

      // Prefer the posting body the board API returned at scan time: it is
      // cleaner than rendered page text and costs no browser page load.
      if (job.description && job.description.length >= 200) {
        jobText = job.description;
      } else if (rawPath && existsSync(rawPath)) {
        jobText = readFileSync(rawPath, 'utf8');
      } else {
        try {
          jobText = await fetchJobText(browser, job.url, pageTimeoutMs);
          const hash = sha1(job.url).slice(0, 12);
          rawPath = path.join(paths.rawDir, `${job.id}-${hash}.txt`);
          writeFileSync(rawPath, jobText);
          updateRawPath.run(rawPath, jobText, job.id);
        } catch (err) {
          insertExtraction.run(
            job.id, JSON.stringify(fallbackExtract('')), modelLabel, 'fetch_failed', nowIsoDate()
          );
          counts.fetch_failed += 1;
          processed += 1;
          logger.error(`Fetch failed: ${job.url} (${err?.name || 'error'})`);
          return;
        }
      }

      const prompt = buildPrompt(jobText.slice(0, inputChars));
      let extracted = null;
      let status = 'ok';

      try {
        let output = '';
        if (config.model.runner === 'gemini') {
          output = await runGemini(geminiModel, config.model.params, prompt, {
            url: config.model.gemini_url,
            timeoutMs: modelTimeoutMs
          });
        } else if (config.model.runner === 'ollama') {
          output = await runOllama(config.model.model_name, config.model.params, prompt, {
            url: config.model.ollama_url,
            timeoutMs: modelTimeoutMs
          });
        } else {
          output = await runLlama(config.model.runner, config.model.model_path, config.model.params, prompt);
        }
        const jsonBlock = extractJsonBlock(output);
        const flat = jsonBlock ? safeJsonParse(jsonBlock) : null;
        if (flat) {
          extracted = liftToEntityGraph(flat);
        } else {
          extracted = fallbackExtract(jobText);
          status = 'fallback';
        }
      } catch (err) {
        // Logged because this was silent before: a quota-exhausted run looked
        // identical to a run of unparseable postings.
        logger.error(`Job ${job.id} model call failed: ${String(err?.message || err).slice(0, 200)}`);
        extracted = fallbackExtract(jobText);
        status = 'fallback';
      }

      extracted = sanitizeExtraction(extracted);
      insertExtraction.run(job.id, JSON.stringify(extracted), modelLabel, status, nowIsoDate());
      counts[status] += 1;
      processed += 1;
      logger.info(`Job ${job.id} extracted status=${status}`);
    }, {
      limit: concurrency,
      perHost,
      shouldStop: () => Date.now() > deadline
    });
  } finally {
    await browser.close().catch(() => {});
  }

  const durationMs = Date.now() - startedAt;
  const budgetExhausted = processed < jobs.length && Date.now() > deadline;
  if (budgetExhausted) {
    // Deliberately not an error: score and report still run against whatever
    // was gathered, and the remainder is picked up by the next run because the
    // job query only selects rows lacking an 'ok' extraction.
    logger.info(`Time budget ${totalBudgetMs}ms exhausted; ${jobs.length - processed} jobs deferred to next run`);
  }

  db.prepare('INSERT INTO runs (run_date, stage, counts_json, duration_ms) VALUES (?, ?, ?, ?)')
    .run(nowIsoDate(), 'extract', JSON.stringify(counts), durationMs);

  logger.info(`Extract finished count=${processed} of ${jobs.length} in ${Math.round(durationMs / 1000)}s`);
  logger.info(`Log file: ${logger.path}`);
  console.log(JSON.stringify({ extracted: processed, of: jobs.length, counts, durationMs }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
