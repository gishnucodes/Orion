import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { nowIsoDate } from './utils.mjs';

export function createLogger(outputDir, prefix = 'run') {
  const logsDir = path.join(outputDir, 'logs');
  mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, `${prefix}-${nowIsoDate()}.log`);

  function line(level, msg) {
    const ts = new Date().toISOString();
    const entry = `[${ts}] [${level}] ${msg}\n`;
    appendFileSync(logPath, entry);
    // Also emit to stdout/stderr so the lines are captured by Cloud Logging
    // (Cloud Run) and the systemd journal (VM) — the file under output/logs is
    // ephemeral on Cloud Run and lost when the container exits. The prefix names
    // the stage so multiplexed pipeline logs stay legible.
    const console_line = `[${prefix}] [${level}] ${msg}`;
    if (level === 'ERROR') console.error(console_line);
    else console.log(console_line);
  }

  return {
    path: logPath,
    info: (msg) => line('INFO', msg),
    warn: (msg) => line('WARN', msg),
    error: (msg) => line('ERROR', msg)
  };
}
