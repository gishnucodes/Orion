import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadConfig } from './config.mjs';

function checkRunner(runner) {
  const res = spawnSync('which', [runner], { stdio: 'pipe' });
  return res.status === 0;
}

async function main() {
  const { config, configPath, portalsPath, cvPath, paths } = loadConfig();
  const issues = [];

  if (!existsSync(configPath)) issues.push(`Missing config.yml at ${configPath}`);
  if (!existsSync(portalsPath)) issues.push(`Missing portals.yml at ${portalsPath}`);
  if (!existsSync(cvPath)) issues.push(`Missing cv.md at ${cvPath}`);

  if (config.model.runner === 'ollama') {
    if (!config.model.model_name) {
      issues.push('Missing model.model_name for ollama runner');
    }
    if (!checkRunner('ollama')) {
      issues.push('Ollama not found in PATH: install ollama and run `ollama pull qwen2.5:0.5b`');
    }
  } else {
    if (!existsSync(config.model.model_path)) {
      issues.push(`Model not found: ${config.model.model_path}`);
    }
    if (!checkRunner(config.model.runner)) {
      issues.push(`llama.cpp runner not found in PATH: ${config.model.runner}`);
    }
  }

  if (issues.length) {
    console.error('Doctor found issues:');
    for (const issue of issues) console.error(`- ${issue}`);
    process.exit(1);
  }

  console.log('Doctor: OK');
  console.log(`Paths: db=${paths.db}`);
  console.log(`Paths: raw_dir=${paths.rawDir}`);
  console.log(`Paths: output_dir=${paths.outputDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
