# Operating Orion

Orion finds jobs, ranks them against your CV, and adds the best **100 per run**
to the tracking sheet. It runs by itself every evening, and you can run it any
time.

## Daily loop

1. **6:00 PM ET**: Cloud Scheduler (`orion-nightly`) runs the job. It takes about 15–45
   minutes.
2. The new batch lands in the sheet. **[Open the tracking sheet](https://docs.google.com/spreadsheets/d/1n4rHrIVF_exQwp086z-S0eE2YwSLXyHdaBYWdsdywrs)**, **Picks** tab.
3. Apply, then set **Status** from the dropdown: Applied, Skipped, Interview,
   Rejected, Offer, Not available, Ineligible. Typing free text works too.
4. The next run copies your statuses into the database (`tracker_status`) and
   BigQuery. The auto-applier then skips any job you've marked.

## Run it now (on demand)

Each run adds a **new batch of 100**, the next best jobs never shown before.

- **Console:** [Cloud Run → Jobs → orion](https://console.cloud.google.com/run/jobs/details/us-central1/orion/executions?project=orion-hunter-2609100955)
  → **EXECUTE**. Leave the overrides empty.
- **Command line:**
  ```bash
  gcloud run jobs execute orion --region us-central1 --project orion-hunter-2609100955
  ```

A run takes about 15–45 minutes, or longer after new boards were added. When the
**Picks** tab gains rows, it's done.

**Don't overlap runs.** Don't start one within about an hour of 6 PM ET, and
don't start one while another is running. Each run pulls the database at the
start and pushes it back at the end, so two overlapping runs overwrite each
other, and one run's picks drop out of the database. The sheet won't get
duplicate rows either way. Check the executions page: nothing should show as
running.

## Where to look

| What | Link |
|---|---|
| Runs and their status | [Job executions](https://console.cloud.google.com/run/jobs/details/us-central1/orion/executions?project=orion-hunter-2609100955) |
| Logs of every run | [Logs Explorer: job orion](https://console.cloud.google.com/logs/query;query=resource.type%3D%22cloud_run_job%22%20resource.labels.job_name%3D%22orion%22?project=orion-hunter-2609100955) |
| Nightly schedule (pause, change time, **FORCE RUN**) | [Cloud Scheduler](https://console.cloud.google.com/cloudscheduler?project=orion-hunter-2609100955) |
| Data | [BigQuery dataset `orion`](https://console.cloud.google.com/bigquery?project=orion-hunter-2609100955) |
| Spend | [Billing reports](https://console.cloud.google.com/billing/018232-99EA07-500F6E/reports?project=orion-hunter-2609100955) |

**One log line per stage** is enough to tell what happened in a run:
`Scan finished`, `Extract finished`, `Score finished`, `Picked …`, `Appended …` (sheet), and
`Synced …` (your statuses).

### BigQuery tables

- `orion.jobs`: every job, its score breakdown, and `application_status`. That
  status is your sheet mark, or the auto-applier's.
- `orion.daily_picks`: every batch. Columns: `batch`, `created_at`, `rank`, `score`.
- `orion.tracker_status`: your sheet statuses as a native table. Querying it needs
  no Drive access.
- `orion.picks_tracker`: a *live* view of the sheet. Querying it needs one-time
  Drive consent: `gcloud auth login --enable-gdrive-access`.

```sql
-- How you've acted on the picks so far
SELECT status, COUNT(*) FROM `orion-hunter-2609100955.orion.tracker_status` GROUP BY status;
```

## Settings (`config.yml`, redeploy after changing)

| Setting | Default | Effect |
|---|---|---|
| `picks.per_run` | 100 | Jobs added to the sheet per run |
| `picks.min_score` | 40 | Floor; below it a posting isn't picked even on a slow day |
| `eligibility.exclude_citizenship_required` | true | Drop roles requiring US citizenship, "U.S. person" status or a clearance |
| `extract.total_budget_ms`, `scoring_v2.semantic.time_budget_ms` | 30 min each | Runtime caps that keep the job inside Cloud Run's free tier |

## Maintenance

- **Monthly: refresh the boards.** Commit the regenerated files, then redeploy.
  ```bash
  node tools/import-slugs.mjs
  ```
  ```bash
  node tools/find-getro-networks.mjs
  ```
- **Deploy after any change:**
  ```bash
  PROJECT_ID=orion-hunter-2609100955 bash deploy/cloudrun-deploy.sh
  ```
  Pushing to GitHub does not deploy; no Cloud Build trigger exists.
- **Check the sheet connection** from inside Cloud Run. This also repairs the Status dropdown:
  ```bash
  gcloud run jobs execute orion --region us-central1 --project orion-hunter-2609100955 --args=node,src/sheet.mjs,--check --wait
  ```

## Costs

The job runs on 2 vCPU and 4 GiB. Cloud Run's free tier covers about **62 minutes a
day averaged over the month**. The nightly run uses 15–45 minutes of that. Each
on-demand run uses the same again, so a few extra runs a week stay free. Going
over costs about $0.16 per hour, billed to the prepaid account.

## When something looks wrong

- **The sheet didn't change:** find the `sheet` line in that run's logs. `up to date`
  means every picked job is already in the sheet. Also check the `pick` line: a
  retried run reuses its batch and doesn't pick again.
- **Few picks** (`Only N jobs cleared the floor`): supply is the limit. Refresh
  the boards, or lower `picks.min_score`.
- **`Model quota exhausted`:** Gemini's free daily quota is spent. Skills still come
  from the gazetteer, and the model-only fields (seniority, years) are retried
  on the next run.
