import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Repository root (directory containing `src/`). */
export const repoRoot = path.resolve(__dirname, '..');

/**
 * Resolve a config path segment strictly under repoRoot.
 * Rejects absolute paths and `..` escapes.
 */
export function resolveUnderRepo(repo, configured, key) {
  if (typeof configured !== 'string' || !configured.trim()) {
    throw new Error(`config paths.${key} must be a non-empty string`);
  }
  const cleaned = configured.trim();
  if (path.isAbsolute(cleaned)) {
    throw new Error(`config paths.${key} must be relative to repo root (got absolute path)`);
  }
  const candidate = path.resolve(repo, cleaned);
  const rel = path.relative(repo, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`config paths.${key} resolves outside repo: ${candidate}`);
  }
  return candidate;
}

export function loadConfig() {
  const configPath = path.resolve(repoRoot, 'config.yml');
  const portalsPath = path.resolve(repoRoot, 'portals.yml');
  const cvPath = path.resolve(repoRoot, 'cv.md');
  const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
  const portals = yaml.load(fs.readFileSync(portalsPath, 'utf8'));
  // Boards found by tools/import-slugs.mjs, kept out of the hand-curated file.
  // Curated entries win: a discovered board already listed is dropped.
  const discoveredPath = path.resolve(repoRoot, 'portals.discovered.yml');
  if (fs.existsSync(discoveredPath)) {
    const discovered = yaml.load(fs.readFileSync(discoveredPath, 'utf8'))?.tracked_companies || [];
    const known = new Set((portals.tracked_companies || []).map((c) => (c.careers_url || '').replace(/\/+$/, '').toLowerCase()));
    portals.tracked_companies = [
      ...(portals.tracked_companies || []),
      ...discovered.filter((c) => !known.has((c.careers_url || '').replace(/\/+$/, '').toLowerCase()))
    ];
  }
  const cv = fs.readFileSync(cvPath, 'utf8');

  const resolved = {
    configPath,
    portalsPath,
    cvPath,
    config,
    portals,
    cv,
    paths: {
      // ORION_DB_PATH lets tests and dry runs point at a copy of the database
      // without editing config.yml (still confined to the repo).
      db: resolveUnderRepo(repoRoot, process.env.ORION_DB_PATH || config.paths.db, 'db'),
      // Owned by the local applier (src/apply); the pipeline only reads it.
      applicationsDb: resolveUnderRepo(repoRoot, config.paths.applications_db || 'db/applications.sqlite', 'applications_db'),
      rawDir: resolveUnderRepo(repoRoot, config.paths.raw_dir, 'raw_dir'),
      outputDir: resolveUnderRepo(repoRoot, config.paths.output_dir, 'output_dir')
    }
  };
  return resolved;
}
