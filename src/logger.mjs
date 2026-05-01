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
  }

  return {
    path: logPath,
    info: (msg) => line('INFO', msg),
    warn: (msg) => line('WARN', msg),
    error: (msg) => line('ERROR', msg)
  };
}
