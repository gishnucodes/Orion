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

## Features

- Local-first scanning and processing pipeline
- Web automation with Playwright for dynamic career pages
- Search-query based discovery via SearXNG
- Structured extraction of job details using a lightweight local model
- Deterministic scoring and filtering rules from `config.yml`
- Personalized ranking using your `cv.md`
- Configurable target sources in `portals.yml`
- End-of-day markdown report generation in `output/`
- Setup health checks via `npm run doctor`
- Optional dashboard via `npm run dashboard`

## User guide

For exact step-by-step setup (create `cv.md`, configure `portals.yml`, start SearXNG, and run the pipeline), see `user-readme.md`.

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

```bash
npm run doctor
npm run run-daily
```

Outputs end-of-day report to `output/daily-YYYY-MM-DD.md`.
