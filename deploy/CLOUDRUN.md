# Running Orion as a scheduled Cloud Run Job (GCP)

This is the serverless alternative to the always-on VM in [`../DEPLOY.md`](../DEPLOY.md).
Instead of hosting a server, Orion runs as a **Cloud Run Job** that Cloud
Scheduler triggers once a night. You pay only for the minutes each run uses.

Because extraction and search are now remote APIs (Gemini + Google Programmable
Search), the container ships no local model — it only needs Node and Chromium.

## Architecture

```
Cloud Scheduler (nightly cron)
        │  POST jobs/orion:run
        ▼
Cloud Run Job "orion"  ──reads──▶  Secret Manager  (API keys, Resend creds)
        │
        │  entrypoint: deploy/cloudrun-entrypoint.mjs
        │    1. download jobs.sqlite from GCS
        │    2. run scan → extract → score → report → notify
        │    3. upload jobs.sqlite back to GCS
        ▼
GCS bucket  <PROJECT>-state/jobs.sqlite   (the one piece of durable state)
```

The SQLite database is the only state that must survive between runs — scan
dedups against it and extract skips already-processed rows. Raw page text and
the rendered report are ephemeral (extract re-fetches missing pages; notify
emails the report and records what it sent).

SQLite stays the operational store because the pipeline needs cheap upserts and
incremental reprocessing, which BigQuery is not built for. At the end of each
run the `export-bq` stage mirrors a denormalized snapshot into BigQuery for
analysis and Looker Studio — see [BigQuery & Looker Studio](#bigquery--looker-studio).

## What's provisioned

| Resource | Name |
|---|---|
| GCS bucket (DB state) | `gs://<PROJECT>-state/jobs.sqlite` |
| Artifact Registry repo | `us-central1-docker.pkg.dev/<PROJECT>/orion` |
| Cloud Run Job | `orion` (region `us-central1`, 2 GiB / 2 vCPU, 3 h task timeout) |
| Runtime service account | `orion-job@<PROJECT>.iam.gserviceaccount.com` (secret accessor + bucket object admin) |
| Scheduler service account | `orion-scheduler@<PROJECT>.iam.gserviceaccount.com` (`run.invoker`) |
| Cloud Scheduler | `orion-nightly` — `0 6 * * *` America/New_York |
| BigQuery dataset/table | `orion.jobs` (denormalized snapshot, reloaded each run) |
| Secrets | `GEMINI_API_KEY`, `GOOGLE_SEARCH_API_KEY`, `GOOGLE_SEARCH_CX`, `RESEND_API_KEY`, `RESEND_TO`, `RESEND_FROM` |

The runtime service account also holds `roles/bigquery.jobUser` and
`roles/bigquery.dataEditor` for the export.

The two API keys are minted restricted to their own API (Gemini key → Generative
Language API only; search key → Custom Search API only).

## First-time setup

```bash
PROJECT_ID=orion-hunter-xxxx BILLING_ACCOUNT=0X0X0X-0X0X0X-0X0X0X \
  bash deploy/cloudrun-setup.sh
```

Then complete the two credentials only you can supply:

1. **Programmable Search Engine id** — create an engine at
   <https://programmablesearchengine.google.com> set to search the entire web,
   copy its *Search engine ID*, and store it:

   ```bash
   printf '%s' 'YOUR_CX_ID' | gcloud secrets versions add GOOGLE_SEARCH_CX \
     --project "$PROJECT_ID" --data-file=-
   ```

2. **Resend** email delivery (see `../DEPLOY.md` for the sender caveats):

   ```bash
   printf '%s' 're_xxxx'        | gcloud secrets versions add RESEND_API_KEY --project "$PROJECT_ID" --data-file=-
   printf '%s' 'you@example.com'| gcloud secrets versions add RESEND_TO      --project "$PROJECT_ID" --data-file=-
   ```

## Deploy / redeploy

Any time the code changes:

```bash
PROJECT_ID=orion-hunter-xxxx bash deploy/cloudrun-deploy.sh
```

This rebuilds the image with Cloud Build and updates the job in place. Secrets
are read fresh on each execution, so updating a secret needs no redeploy.

### Continuous deployment (push to main)

`cloudbuild.yaml` runs on every push to `main` via the `orion-deploy-main`
Cloud Build trigger: formula tests → image build (reusing cached layers) →
push → `gcloud run jobs update --image`. Commits that only touch `*.md` or
`docs/` are skipped. One-time setup (service account, CV secret, GitHub
connection, trigger):

```bash
PROJECT_ID=orion-hunter-xxxx bash deploy/cloudbuild-trigger-setup.sh
```

`cv.md` is gitignored, so builds read it from the `ORION_CV_MD` secret. After
editing your CV, refresh it (and push or re-run the trigger to rebuild):

```bash
gcloud secrets versions add ORION_CV_MD --data-file=cv.md --project orion-hunter-xxxx
gcloud builds triggers run orion-deploy-main --branch=main --region us-central1 --project orion-hunter-xxxx
```

## Operating

```bash
# Trigger a run now
gcloud run jobs execute orion --project "$PROJECT_ID" --region us-central1

# Follow the latest execution's logs
gcloud logging read \
  'resource.type=cloud_run_job AND resource.labels.job_name=orion' \
  --project "$PROJECT_ID" --order=asc --limit 100 --format='value(textPayload)'

# Inspect / download the persisted database
gcloud storage cp "gs://${PROJECT_ID}-state/jobs.sqlite" ./jobs.sqlite
```

**Change the schedule**

```bash
gcloud scheduler jobs update http orion-nightly --project "$PROJECT_ID" \
  --location us-central1 --schedule="0 6 * * *" --time-zone="America/New_York"
```

**Suppress the first-run backlog.** The first execution extracts every job it
discovers, which would email a large pile. Before wiring Resend (or right after
the first run), mark everything already seen so only genuinely new postings mail
going forward — run `notify --mark-seen` once against the persisted DB (download
it, run locally with `.env`, upload it back), or simply accept that the first
digest is large.

## BigQuery & Looker Studio

`deploy/sql/best-matches.sql` is the apply-list query: fresh, ungated, fully
evidenced jobs above the threshold, de-duplicated across repeat postings and
capped per company, with the keywords to add to your resume for each.

```bash
bq query --use_legacy_sql=false < deploy/sql/best-matches.sql
```

Each run's `export-bq` stage reloads `orion.jobs` with one denormalized row per
job (`WRITE_TRUNCATE`, so the table is always the current snapshot): job facts,
the latest extraction (remote, seniority, skills, required_skills, tech_stack,
…), and the latest score. It is gated on the `BQ_DATASET` env var, so it only
runs where that is set.

Query it directly:

```bash
bq query --use_legacy_sql=false \
  'SELECT title, company, location, score FROM orion.jobs WHERE matched ORDER BY score DESC LIMIT 25'
```

**Build a Looker Studio dashboard:**

1. Open <https://lookerstudio.google.com> → **Create → Data source → BigQuery**.
2. Pick project `orion-hunter-...` → dataset `orion` → table `jobs` → **Connect**.
3. Set field types once: mark `first_seen` / `last_seen` as **Date**, `score` as
   a metric (the repeated `skills` fields come through as lists for filtering).
4. Build charts — e.g. a scorecard of matched jobs, a bar chart of jobs by
   company, a table sorted by `score`, a filter on `remote` / `seniority`.

Because the table is reloaded every run, the dashboard reflects the latest state
each morning with no further wiring. To keep history instead of a snapshot,
switch the export to `WRITE_APPEND` and add a run-id/date column.

## Job sources

Discovery runs in two ways (both in `src/scan.mjs`):

- **Direct company boards** — `portals.tracked_companies` entries, each routed by
  `inferPlatform()` to a structured API fetcher: **Greenhouse, Lever, Ashby,
  SmartRecruiters, Workable, Recruitee**. Unknown platforms (including Workday,
  deferred) fall back to generic HTML scraping. Add a board with one entry:
  `- name: Acme` / `careers_url: https://jobs.ashbyhq.com/acme` / `enabled: true`
  (add an explicit `platform:` only if the URL can't be auto-detected).
- **Web search** — `portals.search_queries` via Google Programmable Search.
  **Requires `GOOGLE_SEARCH_CX` to be set** (still a placeholder by default); until
  then all search-based discovery is inert and only direct boards produce jobs.

Every source's titles pass the same `titleAllowed` gate at ingest, so irrelevant
postings are never extracted regardless of where they came from.

Auto-apply is intentionally **not** built — see
[AUTO-APPLY.md](../docs/AUTO-APPLY.md) for the feasibility analysis and the
recommended "assisted apply" design.

## Cost

Per the estimate that motivated this migration: Gemini extraction and Custom
Search are a few dollars a month combined; Cloud Run bills only for the nightly
run (tens of seconds to ~an hour of 2 vCPU / 2 GiB), typically well under a
dollar a month. Keeping `scan.search_max_results` at 10 keeps Custom Search
inside its 100-queries/day free tier.
