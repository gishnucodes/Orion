# User Guide: Run the Job Scanner

This guide tells you exactly what to do from a clean clone to a full run.

## 1) Prerequisites

Install these first:

- Node.js 18+ and npm
- Docker (to run SearXNG)
- Ollama (default local model runner)

## 2) Open the project

From terminal:

```bash
cd /Applications/code/orion-hunter/Orion
```

Install dependencies:

```bash
npm install
npx playwright install chromium
```

## 3) Create your `cv.md`

Create a file named `cv.md` in the project root.

Example:

```md
# Your Name

## Summary
AI engineer focused on LLM systems and backend platforms.

## Experience
- Company A ...
- Company B ...

## Skills
- Python, JavaScript, SQL, Docker, Kubernetes
```

Important:

- Keep the filename exactly `cv.md`
- Put your real experience/skills (this is used for scoring)

## 4) Create your portals file (`portals.yml`)

The app reads `portals.yml` (not `portals.yaml`) from the project root.

If you have a `portals.yaml`, rename it:

```bash
mv portals.yaml portals.yml
```

Minimum structure:

```yaml
title_filter:
  positive:
    - "AI Engineer"
    - "Applied AI Engineer"
  negative:
    - "Intern"
    - "Junior"
  seniority_boost:
    - "Senior"
    - "Staff"

search_queries:
  - name: Greenhouse AI
    query: 'site:boards.greenhouse.io "AI Engineer" remote'
    enabled: true

tracked_companies:
  - name: Anthropic
    careers_url: https://job-boards.greenhouse.io/anthropic
    api: https://boards-api.greenhouse.io/v1/boards/anthropic/jobs
    enabled: true
```

Tips:

- Add more queries in `search_queries` for better coverage
- Set `enabled: true` only for sources you want scanned

## 5) Start SearXNG (required when `search_provider: searxng`)

This project is configured to call `http://localhost:8080`, so run SearXNG on port `8080`.

From project root:

```bash
docker run --rm -d \
  --name searxng-local \
  -p 8080:8080 \
  -v "$(pwd)/searxng/settings.yaml:/etc/searxng/settings.yml:ro" \
  searxng/searxng:latest
```

Check that it is running:

```bash
curl "http://localhost:8080/search?q=test&format=json"
```

If you want to stop it later:

```bash
docker stop searxng-local
```

## 6) Start Ollama model (default runner)

Pull the default model:

```bash
ollama pull qwen2.5:0.5b
```

The app uses this model by default from `config.yml`.

## 7) Validate setup

Run:

```bash
npm run doctor
```

Fix any reported missing files before continuing.

## 8) Start the full process

Run the full daily pipeline:

```bash
npm run run-daily
```

This performs scan -> extract -> score -> report.

## 9) View outputs

Generated files:

- Daily report: `output/daily-YYYY-MM-DD.md`
- Latest scan metadata: `output/last-scan.json`
- Database: `db/jobs.sqlite`

## Optional: run each step manually

```bash
npm run scan
npm run extract
npm run score
npm run report
```

## Optional: start dashboard

```bash
npm run dashboard
```

