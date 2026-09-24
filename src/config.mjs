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
  const cv = fs.readFileSync(cvPath, 'utf8');

  const resolved = {
    configPath,
    portalsPath,
    cvPath,
    config,
    portals,
    cv,
    paths: {
      db: resolveUnderRepo(repoRoot, config.paths.db, 'db'),
      // Owned by the local applier (src/apply); the pipeline only reads it.
      applicationsDb: resolveUnderRepo(repoRoot, config.paths.applications_db || 'db/applications.sqlite', 'applications_db'),
      rawDir: resolveUnderRepo(repoRoot, config.paths.raw_dir, 'raw_dir'),
      outputDir: resolveUnderRepo(repoRoot, config.paths.output_dir, 'output_dir')
    }
  };
  return resolved;
}
