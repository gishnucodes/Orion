import express from 'express';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { openDb } from '../src/db.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

function loadConfig() {
  const configPath = path.resolve(root, 'config.yml');
  const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
  return {
    dbPath: path.resolve(root, config.paths.db)
  };
}

const app = express();
const port = process.env.PORT || 3000;
const { dbPath } = loadConfig();
if (!fs.existsSync(dbPath)) {
  const bootstrap = openDb(dbPath);
  bootstrap.close();
}
const db = new Database(dbPath, { readonly: true });

function parseReasons(row) {
  try {
    const breakdown = row.breakdown_json ? JSON.parse(row.breakdown_json) : {};
    return breakdown.reasons || [];
  } catch {
    return [];
  }
}

app.get('/api/jobs', (req, res) => {
  const matched = req.query.matched;
  const minScore = Number(req.query.min_score || 0);
  const company = (req.query.company || '').toString().trim().toLowerCase();
  const title = (req.query.title || '').toString().trim().toLowerCase();
  const limit = Math.min(Number(req.query.limit || 200), 1000);

  let where = '1=1';
  const params = [];

  if (matched === '1') {
    where += ' AND s.matched = 1';
  } else if (matched === '0') {
    where += ' AND s.matched = 0';
  }

  if (!Number.isNaN(minScore) && minScore > 0) {
    where += ' AND s.score >= ?';
    params.push(minScore);
  }

  if (company) {
    where += ' AND lower(j.company) LIKE ?';
    params.push(`%${company}%`);
  }

  if (title) {
    where += ' AND lower(j.title) LIKE ?';
    params.push(`%${title}%`);
  }

  const rows = db.prepare(`
    SELECT j.id, j.company, j.title, j.url, j.location, j.first_seen, j.last_seen,
           s.score, s.matched, s.breakdown_json
    FROM jobs j
    JOIN scores s ON s.job_id = j.id
    WHERE s.id IN (SELECT MAX(id) FROM scores GROUP BY job_id)
      AND ${where}
    ORDER BY s.score DESC, j.last_seen DESC
    LIMIT ?
  `).all(...params, limit);

  const data = rows.map((r) => ({
    id: r.id,
    company: r.company,
    title: r.title,
    url: r.url,
    location: r.location,
    first_seen: r.first_seen,
    last_seen: r.last_seen,
    score: r.score,
    matched: r.matched,
    reasons: parseReasons(r)
  }));

  res.json({ count: data.length, jobs: data });
});

app.get('/api/job/:id', (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid id' });

  const row = db.prepare(`
    SELECT j.id, j.company, j.title, j.url, j.location, j.first_seen, j.last_seen,
           s.score, s.matched, s.breakdown_json,
           e.json AS extraction_json
    FROM jobs j
    JOIN scores s ON s.job_id = j.id
    JOIN extractions e ON e.job_id = j.id
    WHERE s.id IN (SELECT MAX(id) FROM scores WHERE job_id = j.id)
      AND e.id IN (SELECT MAX(id) FROM extractions WHERE job_id = j.id)
      AND j.id = ?
  `).get(id);

  if (!row) return res.status(404).json({ error: 'not found' });

  let extraction = {};
  let breakdown = {};
  try {
    extraction = row.extraction_json ? JSON.parse(row.extraction_json) : {};
  } catch {
    extraction = {};
  }
  try {
    breakdown = row.breakdown_json ? JSON.parse(row.breakdown_json) : {};
  } catch {
    breakdown = {};
  }

  res.json({
    id: row.id,
    company: row.company,
    title: row.title,
    url: row.url,
    location: row.location,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    score: row.score,
    matched: row.matched,
    reasons: breakdown.reasons || [],
    breakdown,
    extraction
  });
});

app.use('/', express.static(path.join(__dirname, 'public')));

app.listen(port, () => {
  console.log(`Dashboard running at http://localhost:${port}`);
});
