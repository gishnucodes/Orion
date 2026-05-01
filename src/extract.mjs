import { chromium } from 'playwright';
import { loadConfig } from './config.mjs';
import { openDb } from './db.mjs';
import { extractJsonBlock, safeJsonParse, nowIsoDate, sha1, normalizeWhitespace } from './utils.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createLogger } from './logger.mjs';

function buildPrompt(jobText) {
  return [
    'You are a strict JSON generator.',
    'Return ONLY valid JSON with this schema:',
    '{',
    '  "title": string,',
    '  "company": string,',
    '  "location": string|null,',
    '  "remote": boolean|null,',
    '  "seniority": string|null,',
    '  "responsibilities": string[],',
    '  "requirements": string[],',
    '  "skills": string[],',
    '  "years_experience": number|null,',
    '  "visa": string|null,',
    '  "salary": string|null,',
    '  "entity_graph": {',
    '    "role_title": string|null,',
    '    "company": string|null,',
    '    "location": string|null,',
    '    "remote_policy": string|null,',
    '    "seniority": string|null,',
    '    "employment_type": string|null,',
    '    "required_skills": string[],',
    '    "nice_to_have_skills": string[],',
    '    "tools": string[],',
    '    "tech_stack": string[],',
    '    "years_experience_min": number|null,',
    '    "years_experience_max": number|null,',
    '    "domain_keywords": string[],',
    '    "product_keywords": string[],',
    '    "work_authorization": string|null,',
    '    "visa_sponsorship": string|null,',
    '    "salary_range": string|null,',
    '    "benefits": string[],',
    '    "responsibilities": string[]',
    '  }',
    '}',
    'If unknown, use null or empty array.',
    'Job description follows:',
    jobText
  ].join('\n');
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

async function runOllama(modelName, params, prompt) {
  const body = {
    model: modelName,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    options: {
      temperature: params.temp ?? 0,
      top_p: params.top_p ?? 1,
      top_k: params.top_k ?? 1,
      seed: params.seed ?? 42
    }
  };
  const res = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ollama error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.message?.content || '';
}

async function fetchJobText(url, timeoutMs) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.waitForTimeout(1500);
  const text = await page.evaluate(() => document.body.innerText || '');
  await browser.close();
  return normalizeWhitespace(text);
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
  const { config, paths } = loadConfig();
  const db = openDb(paths.db);
  mkdirSync(paths.rawDir, { recursive: true });
  const logger = createLogger(paths.outputDir, 'extract');
  logger.info('Extract started');

  const jobs = db.prepare(`
    SELECT j.id, j.url, j.raw_path
    FROM jobs j
    LEFT JOIN extractions e ON e.job_id = j.id AND e.status = 'ok'
    WHERE e.id IS NULL
    ORDER BY j.id ASC
    LIMIT ?
  `).all(config.extract?.max_jobs ?? 100);
  logger.info(`Jobs to extract: ${jobs.length}`);

  for (const job of jobs) {
    let rawPath = job.raw_path;
    let jobText = null;
    logger.info(`Job ${job.id} fetch ${job.url}`);

    if (rawPath && existsSync(rawPath)) {
      jobText = readFileSync(rawPath, 'utf8');
    } else {
      try {
        jobText = await fetchJobText(job.url, config.extract?.timeout_ms ?? 60000);
        const hash = sha1(job.url).slice(0, 12);
        rawPath = path.join(paths.rawDir, `${job.id}-${hash}.txt`);
        writeFileSync(rawPath, jobText);
        db.prepare('UPDATE jobs SET raw_path = ? WHERE id = ?').run(rawPath, job.id);
      } catch (err) {
        db.prepare('INSERT INTO extractions (job_id, json, model, status, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(job.id, JSON.stringify(fallbackExtract('')), config.model.model_path, 'fetch_failed', nowIsoDate());
        logger.error(`Fetch failed: ${job.url} (${err?.name || 'error'})`);
        continue;
      }
    }

    const prompt = buildPrompt(jobText.slice(0, 12000));
    let extracted = null;
    let status = 'ok';

    try {
      let output = '';
      if (config.model.runner === 'ollama') {
        output = await runOllama(config.model.model_name, config.model.params, prompt);
      } else {
        output = await runLlama(config.model.runner, config.model.model_path, config.model.params, prompt);
      }
      const jsonBlock = extractJsonBlock(output);
      extracted = jsonBlock ? safeJsonParse(jsonBlock) : null;
      if (!extracted) {
        extracted = fallbackExtract(jobText);
        status = 'fallback';
      }
    } catch {
      extracted = fallbackExtract(jobText);
      status = 'fallback';
    }

    extracted = sanitizeExtraction(extracted);
    db.prepare('INSERT INTO extractions (job_id, json, model, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(job.id, JSON.stringify(extracted), config.model.model_path, status, nowIsoDate());
    logger.info(`Job ${job.id} extracted status=${status}`);
  }

  logger.info(`Extract finished count=${jobs.length}`);
  logger.info(`Log file: ${logger.path}`);
  console.log(JSON.stringify({ extracted: jobs.length }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
