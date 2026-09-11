/**
 * Semantic similarity via a local sentence-embedding model (transformers.js on
 * onnxruntime-node). No API quota and no billing: the model runs on the Cloud
 * Run CPU. The image pre-downloads it (see Dockerfile); locally it is fetched
 * once into ORION_HF_CACHE / .cache/hf.
 *
 * For each JD chunk we store only its best cosine similarity against the CV and
 * its section weight. The τ calibration is applied at score time, so tuning
 * tau_lo/tau_hi never forces a re-embed; only a changed posting, CV or model does.
 */
import path from 'node:path';
import { repoRoot } from '../config.mjs';

const MEMO_LIMIT = 20000;

export async function createEmbedder({ model, dtype, batchSize = 32 }) {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = process.env.ORION_HF_CACHE || path.join(repoRoot, '.cache', 'hf');
  env.allowRemoteModels = true;
  const extractor = await pipeline('feature-extraction', model, { dtype });
  const memo = new Map();

  async function embed(texts) {
    const missing = [...new Set(texts.filter((t) => !memo.has(t)))];
    for (let i = 0; i < missing.length; i += batchSize) {
      const batch = missing.slice(i, i + batchSize);
      // BGE is trained for CLS pooling; normalised so dot product == cosine.
      const out = await extractor(batch, { pooling: 'cls', normalize: true });
      const [, dim] = out.dims;
      for (let j = 0; j < batch.length; j += 1) {
        memo.set(batch[j], out.data.slice(j * dim, (j + 1) * dim));
      }
    }
    const vectors = texts.map((t) => memo.get(t));
    // Boilerplate repeats across a company's postings, so the memo pays for
    // itself — but it must not grow without bound over a 5,000-job run.
    if (memo.size > MEMO_LIMIT) memo.clear();
    return vectors;
  }

  return { embed };
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

/** For each JD chunk, its best match among CV chunks: [[sim, weight], ...]. */
export function bestMatches(jdVectors, weights, cvVectors) {
  return jdVectors.map((q, i) => {
    let best = -1;
    for (const e of cvVectors) {
      const s = dot(q, e);
      if (s > best) best = s;
    }
    return [Math.round(best * 1000) / 1000, weights[i]];
  });
}
