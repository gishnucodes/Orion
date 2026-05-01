import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { repoRoot } from './config.mjs';

function run(step) {
  const script = path.join(repoRoot, 'src', `${step}.mjs`);
  const result = spawnSync('node', [script], { stdio: 'inherit', cwd: repoRoot });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run('scan');
run('extract');
run('score');
run('report');
