# Deploying Orion to run 24/7

Orion runs nightly on a small Linux server and emails you newly matched jobs.
This document covers where to host it and how to set it up.

> **Serverless alternative (GCP):** to run Orion as a scheduled Cloud Run Job
> instead of an always-on VM — paying only for each nightly run — see
> [`deploy/CLOUDRUN.md`](deploy/CLOUDRUN.md). That path uses the Gemini API for
> extraction and Google Programmable Search for discovery, so it ships no local
> model.

## Where to host

Orion needs to co-locate three things: Node + headless Chromium, an Ollama
model, and the SQLite database. That rules out most "free tier" platforms,
which either sleep, cap CPU-hours, or give you too little RAM for Chromium.

| Option | Cost | Verdict |
|---|---|---|
| **Oracle Cloud Always Free** (`VM.Standard.A1.Flex`, 4 OCPU / 24 GB, arm64) | Free forever | **Recommended.** Runs everything as-is with room to spare. |
| Hetzner CX22 or similar VPS | ~$5/mo | Best fallback. No capacity lottery, instantly available. |
| GitHub Actions | Free | Workable but awkward: no persistent disk, so SQLite must be committed back to the repo or cached, and a nightly run burns most of the 2,000 min/month private quota. |
| GCP `e2-micro` free tier | Free | Too small. 1 GB RAM will not hold Chromium plus a model. |
| Fly.io / Render / Railway free tiers | Free | Sleep or cap CPU-hours below what a nightly run needs. |

**Oracle capacity caveat.** Free ARM (A1) capacity is frequently exhausted and
instance creation fails with `Out of host capacity`. Choose a less busy home
region at signup. If it stays unavailable, take the Hetzner fallback rather than
retrying indefinitely — the x86 Always Free shape (`E2.1.Micro`, 1 GB RAM) is
not big enough for this workload.

Resource use in practice: Chromium peaks around 1–1.5 GB with 4 concurrent
pages, `qwen2.5:0.5b` is ~400 MB resident, and the database plus cached page
text grows about 12 KB per job.

## Provisioning

From your laptop, with the repo as your working directory:

```bash
bash deploy/push.sh -k ~/.ssh/orion.key --seed --setup ubuntu@<PUBLIC_IP>
```

That copies the application, your `cv.md` and `.env`, and (with `--seed`) the
existing database, then runs `deploy/setup.sh` on the host. Setup is idempotent:
it installs Node 20, npm dependencies, Playwright Chromium with its system
libraries, Ollama and the model, creates an `orion` service user, and installs
the systemd unit and timer. Expect several minutes, mostly Chromium and Ollama.

Run `push.sh` again any time you change configuration or code — it is safe to
repeat, and `--setup` can be omitted once the host is provisioned.

`node_modules` and the Playwright browser cache are deliberately **not** copied:
`better-sqlite3` is a native module and Chromium is a platform binary, so both
must be built or downloaded on the arm64 host.

### Email (Resend)

1. Sign up at [resend.com](https://resend.com) — the free tier allows 3,000
   emails/month and 100/day, far more than one digest a night needs.
2. Create an API key at **API Keys → Create**. Sending permission is enough.
3. Put the values into `/opt/orion/.env` (mode 600, created by the setup script):

```bash
RESEND_API_KEY=re_xxxxxxxxxxxx
RESEND_TO=you@example.com
RESEND_FROM="Orion <onboarding@resend.dev>"
```

**About the sender.** `onboarding@resend.dev` is Resend's shared test sender and
needs no DNS setup, but it will only deliver to the address registered on your
Resend account. That is fine when you are the only recipient. To send anywhere
else — or to keep the mail out of spam long-term — verify a domain you own under
**Domains**, add the DNS records it gives you, and set `RESEND_FROM` to an
address on that domain.

Verify the credentials before the first run — this validates the key against the
API without printing it, and `--send` posts a real test message:

```bash
sudo -u orion bash /opt/orion/deploy/check-resend.sh --send
```

### Your CV

`cv.md` is gitignored, but `push.sh` copies it explicitly. Scoring reads the
whole CV (keywords and semantic matching), so keep it complete. If you skipped it, copy it by
hand:

```bash
scp -i ~/.ssh/orion.key cv.md ubuntu@<PUBLIC_IP>:/tmp/cv.md
ssh -i ~/.ssh/orion.key ubuntu@<PUBLIC_IP> 'sudo cp /tmp/cv.md /opt/orion/cv.md && sudo chown orion:orion /opt/orion/cv.md'
```

### Seeding and suppressing the backlog

`push.sh --seed` copies your local `db/jobs.sqlite` so the first server run is
incremental rather than a multi-hour cold start — `extract` only processes jobs
that lack a successful extraction.

Then suppress the existing backlog so the first run does not email a pile of
old matches:

```bash
sudo -u orion bash -c 'cd /opt/orion && node --env-file=.env src/notify.mjs --mark-seen'
```

> Postings in a seeded database may already be closed. Orion guards against
> mailing dead links with `notify.max_age_days` (default 7): a job is only sent
> if a scan has seen it on a board within that window.

## Running

```bash
sudo -u orion bash -c 'cd /opt/orion && npm run doctor'
sudo systemctl start orion.service     # one manual run
journalctl -u orion -f                 # follow it
```

Once a manual run looks right, enable the schedule:

```bash
sudo systemctl start orion.timer
systemctl list-timers orion.timer
```

The timer fires at 03:00 daily with up to 30 minutes of jitter, and
`Persistent=true` catches up on a missed run after a reboot.

## Operations

**Logs.** `journalctl -u orion --since today` for the run; per-stage logs are in
`/opt/orion/output/logs/`.

**Time budget.** `extract.total_budget_ms` (default 90 min) stops the extract
stage cleanly if it overruns; leftover jobs are picked up the next night.
`TimeoutStartSec=3h` in the unit is a hard backstop.

**Tuning matches.** `config.yml` `scoring_v2.threshold` (0–100, default 65)
and `scoring_v2.daily_top_n` (default 15) control how much reaches your inbox.
Re-scoring is cheap and needs no re-extraction (embeddings are cached):

```bash
sudo -u orion bash -c 'cd /opt/orion && npm run score && npm run report'
```

**Disk.** `raw/` grows unbounded (~12 KB per job). Prune periodically:

```bash
sudo -u orion find /opt/orion/raw -name '*.txt' -mtime +90 -delete
```

**Dashboard.** `dashboard/server.mjs` has no authentication. Do not open port
3000 to the internet; reach it over an SSH tunnel instead:

```bash
ssh -L 3000:localhost:3000 <user>@<server>
```

## Troubleshooting

**Chromium fails to launch on arm64.** Re-run the browser install and check the
system libraries:

```bash
sudo -u orion bash -c 'cd /opt/orion && PLAYWRIGHT_BROWSERS_PATH=/opt/orion/.playwright node node_modules/playwright/cli.js install chromium'
sudo node /opt/orion/node_modules/playwright/cli.js install-deps chromium
```

If Playwright's own build will not run, install the distro package and set
`chromium.launch({ channel: 'chromium' })`.

**`npx playwright` fails with `Cannot find module './lib/program'`.** The
`node_modules/.bin` shim is stale. Call the CLI directly:
`node node_modules/playwright/cli.js install chromium`.

**Extraction is slow or everything comes back `fallback`.** Check that Ollama is
up (`systemctl status ollama`) and the model is present (`ollama list`). The
extract stage caps generation with `model.params.num_predict` and aborts a
request after `model.request_timeout_ms`; a small model asked for a large schema
will loop until those limits and produce unparseable output.

**No email arrives.** `notify` is intentionally silent when there are no new
matches. Check what it would send — `--dry-run` also writes a rendered preview to
`output/notify-preview.html`:

```bash
sudo -u orion bash -c 'cd /opt/orion && node --env-file=.env src/notify.mjs --dry-run'
```

If there are matches but no mail lands, run `deploy/check-resend.sh --send`. The
usual causes are a `RESEND_TO` that is not the address on your Resend account
while using the shared `onboarding@resend.dev` sender, or an unverified domain
in `RESEND_FROM`.

`notify` failing does not fail the nightly run, and unsent matches are retried
the next night because jobs are only recorded once a send succeeds.
