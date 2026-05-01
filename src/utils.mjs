import crypto from 'node:crypto';

export function nowIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

export function sha1(input) {
  return crypto.createHash('sha1').update(input).digest('hex');
}

export function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

export function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function extractJsonBlock(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  return match[0];
}
