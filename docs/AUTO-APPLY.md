# Auto-apply

`npm run apply` opens a **visible Chrome window on your Mac**, works through
matched jobs from best score down, fills each application, and **submits only
when every check passes**. Otherwise it pauses and asks you. What you type
while it's paused is learned into `applicant-memory.md`, so the same question
doesn't stop it twice.

It is interactive by design. It never runs in the nightly Cloud Run job.

## Setup (once)

1. **Profile.** Fill in the `null`s in `applicant.yml` (gitignored; see
   `applicant.example.yml`). Anything left `null` is treated as unknown: the
   first form that needs it pauses and asks you, and your answer is learned.
2. **Gemini key.** Create a separate free-tier key in AI Studio so the
   applier doesn't use up the nightly extraction quota. Add it to `.env`:
   ```
   GEMINI_APPLY_API_KEY=...
   ```
   Optional overrides: `GEMINI_APPLY_MODEL` (default `gemini-3.5-flash`, used
   for form answers and memory merges) and `GEMINI_CU_MODEL` (default
   `gemini-3.8-flash`, used for Computer Use).
3. **GCS access**, for syncing with the pipeline:
   `gcloud auth application-default login`. Use `--no-sync` to work offline
   against the local databases.
4. **Logins.** The browser profile lives in `~/.orion/chrome-profile` and is
   kept between runs. Sign in to Workday tenants or anything else by hand
   once; the agent never types passwords.

## Running

```
npm run apply                               # shadow mode, top 5 jobs
npm run apply -- --mode confident --limit 3 # real auto-submit
npm run apply -- --job 3778 --mode review   # one job, always pause before submit
npm run apply -- --retry-failed             # re-queue jobs that failed before
```

| Mode | Behaviour |
|---|---|
| `shadow` (default) | Fills everything and runs the gate, then logs "would submit". Never clicks Submit. Use it to check the gate's decisions before trusting it. |
| `review` | Always pauses before Submit. |
| `confident` | Auto-submits when the gate passes; otherwise pauses. |

When it pauses, it prints the reasons and the fields that need you. You work
in the Chrome window, then choose one of:

- `[s]` submit: the agent clicks Submit
- `[r]` re-check after you've fixed things
- `[c]` continue: Computer Use resumes
- `[d]` I submitted it myself
- `[k]` skip this job for good
- `[l]` leave it for a later run
- `[q]` quit

## How it works

```
jobs.sqlite (GCS snapshot) ─▶ queue: matched, fresh, not yet handled, by score
     │
     ▼  per job
  Greenhouse / Lever / Ashby ─▶ DOM engine
     scan form (form-scan) → answers: applicant.yml rules, then ONE Gemini call
     per form with memory + CV + JD (answer) → fill (form-fill)
  Workday / other sites / DOM failure ─▶ Computer Use engine
     screenshot → Gemini action → Playwright → … (computer-use)
     │
     ▼
  gate (gate.mjs) ─▶ submit │ pause for you (learn → applicant-memory.md)
     │
     ▼
  applications.sqlite ─▶ GCS ─▶ nightly job: BigQuery application_status,
                                 notify skips applied jobs
```

**The submit gate.** It auto-submits only if **all** of these hold:

- mode is `confident`;
- the ATS is Greenhouse, Lever or Ashby (Computer Use applications are always
  reviewed in v1);
- no required field is unanswered;
- no field failed to fill;
- no answer is low-confidence or an unreviewed generated essay;
- the form shows no validation errors;
- no CAPTCHA challenge is visible;
- the company isn't in `submit.never_auto_submit`;
- `submit.daily_cap` isn't reached.

**What is never automated:**

- Passwords, logins and account creation.
- CAPTCHAs. All three ATSes embed *invisible* CAPTCHAs; if a visible challenge
  appears, the agent hands it to you and never solves it.
- Legal acknowledgements and arbitration or privacy agreements. These pause
  unless you set `consents.auto_accept: true`.
- Facts you haven't given it. Visa status, salary and the like come only from
  `applicant.yml` or `applicant-memory.md`, never inferred from the CV.

**Learning.**

- At every pause the agent snapshots the form, and snapshots it again when you
  hand control back.
- The difference between the two is what you filled in or corrected. Together
  with an optional note, Gemini folds it into `applicant-memory.md` under
  **Answers**, **Preferences**, **Site notes** and **Don'ts**.
- The previous version is kept as `.bak`.
- If the model's rewrite drops sections or content, the lessons are appended
  verbatim instead, so nothing you typed is lost.
- Password fields, login pages, file uploads and legal acknowledgements are
  never learned from.
- The file is plain markdown, so edit it freely. It is backed up to GCS next to
  `applications.sqlite`.

**State.**

- `db/applications.sqlite` is kept separate from `jobs.sqlite` so it never
  races the 6 PM nightly write.
- It is uploaded to `gs://<bucket>/applications.sqlite` with a generation
  precondition; a lost race re-pulls, merges (newest row wins) and retries.
- Confirmation screenshots go to `output/applications/<job_id>/`.

## Files

| File | Role |
|---|---|
| `src/apply/index.mjs` | CLI, queue, browser, gate/submit loop, GCS sync |
| `src/apply/form-scan.mjs` / `form-fill.mjs` | ATS-agnostic form reading and filling |
| `src/apply/adapters.mjs` | Greenhouse/Lever/Ashby form URLs, question schemas, submit and success detection |
| `src/apply/profile.mjs` / `answer.mjs` | Deterministic answers, then batched Gemini answers |
| `src/apply/computer-use.mjs` | Gemini Computer Use loop (Interactions API) |
| `src/apply/gate.mjs` / `captcha.mjs` | Submit decision; visible-challenge detection |
| `src/apply/learn.mjs` / `memory.mjs` / `pause.mjs` | Pauses, form diffs, memory rewrite |
| `src/apply/store.mjs` | `applications.sqlite` |

## Later

- Run on a GCE VM under Xvfb + noVNC, reached over an IAP tunnel, so you can
  watch it remotely.
- A per-job "Apply" button on the dashboard.
- Cover-letter generation.
