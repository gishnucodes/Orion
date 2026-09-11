/**
 * Build-time model download, so the Cloud Run job never depends on the Hugging
 * Face Hub being reachable at 6 PM. Reads the model id from config.yml when
 * present, falling back to the scoring default.
 */
import { existsSync, readFileSync } from 'node:fs';
import { pipeline, env } from '@huggingface/transformers';
import yaml from 'js-yaml';

const configured = existsSync('config.yml')
  ? yaml.load(readFileSync('config.yml', 'utf8'))?.scoring_v2?.semantic
  : null;
const model = process.env.ORION_EMBED_MODEL || configured?.model || 'Xenova/bge-small-en-v1.5';
const dtype = configured?.dtype || 'q8';

env.cacheDir = process.env.ORION_HF_CACHE || '.cache/hf';
const extractor = await pipeline('feature-extraction', model, { dtype });
const out = await extractor(['warm-up sentence'], { pooling: 'cls', normalize: true });
console.log(`cached ${model} (${dtype}) in ${env.cacheDir}, dim=${out.dims[1]}`);
