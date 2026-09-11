# Orion: The Job Hunter

This is a minimal, local-first job scanner. It uses Playwright to scan portals, a small local SLM (via `llama.cpp`) to extract job details, and deterministic rules to score matches.

inspired by https://github.com/santifer/career-ops : but this repository is heavy on claude usage, therefore created this minimal version, which does not consume any credits and runs lcoally. 

I hope the community will port / fork the code and make more useful products. 

## Why we use this

Job hunting across many company portals is repetitive and noisy. This repo automates that workflow so you can:

- Discover relevant jobs faster from multiple sources
- Rank opportunities based on your profile (`cv.md`)
- Keep the process local-first and reproducible
- Generate a daily shortlist instead of manually checking many sites

## Deployment

The pipeline is designed to run unattended on a small server and push new
matches to you by email. See `DEPLOY.md` for the full walkthrough; `deploy/setup.sh`
provisions a fresh Ubuntu host end to end.

## Features

- Local-first scanning and processing pipeline
- Web automation with Playwright for dynamic career pages
- Search-query based discovery via SearXNG
- Structured extraction of job details using a lightweight local model
- Deterministic scoring and filtering rules from `config.yml`
- Personalized ranking using your `cv.md`
- Configurable target sources in `portals.yml`
- End-of-day markdown report generation in `output/`
- Email digest of newly matched jobs via `npm run notify` (Resend)
- Setup health checks via `npm run doctor`
- Optional dashboard via `npm run dashboard`
- Unattended nightly operation via systemd (`deploy/`)

## User guide

For exact step-by-step setup (create `cv.md`, configure `portals.yml`, start SearXNG, and run the pipeline), see `USER_GUIDE.md`.

## Setup

```bash
cd minimal-job-scanner
npm install
npx playwright install chromium
```

Default runner is Ollama. Install it and pull a small model:

```bash
ollama pull qwen2.5:0.5b
```

If you prefer `llama.cpp`, place your GGUF at `models/qwen2.5-0.5b-instruct.gguf` (or update `config.yml`) and set `model.runner: llama-cli`.

## Run

Copy `cv.example.md` to `cv.md` and replace it with your real CV. `cv.md` is
gitignored. Scoring reads the whole CV: keyword matching checks whether a
posting's exact terms appear anywhere in it (as an ATS would), and semantic
matching compares your experience bullets with the posting's requirements.

### Scoring (v2)

Each job gets a 0–100 score, shown as x.x/10 (`src/score.mjs`, `src/scoring/`):

```
base  = 0.30·Skills + 0.45·Keywords + 0.25·Semantic
Score = 100 · clamp(base + Δ, 0, 1)
```

- **Skills** — coverage of the extracted required / other skills, with aliases
  (GCP = Google Cloud) and partial credit for related skills.
- **Keywords** — 0.25·title tier + 0.75·ATS match rate: the share of the
  posting's top tf-idf keywords found literally in your CV. Misses are listed
  per job as resume gaps.
- **Semantic** — per-requirement similarity from a local embedding model
  (`bge-small-en-v1.5`, no API calls), cached in `semantic_cache`.
- **Δ** — seniority, years of experience, employment type, sponsorship, domain.

Blocked titles and explicitly non-US locations are gates, not scores. Weights,
tiers and thresholds live under `scoring_v2` in `config.yml`; `npm test` covers
the formula.

```bash
cp cv.example.md cv.md
npm run doctor
npm run run-daily
```

Outputs an end-of-day report to `output/daily-YYYY-MM-DD.md`, and pushes any
newly matched jobs by email when `RESEND_API_KEY` and `RESEND_TO` are set.
