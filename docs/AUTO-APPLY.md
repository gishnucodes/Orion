# Auto-apply: feasibility and a responsible design

Status: **not implemented.** This documents what is realistic, what the hard
constraints are, and the phased design to build toward — so the decision is made
with eyes open rather than discovering the limits mid-build.

## Hard constraints (these do not go away)

- **No unattended credential entry or form submission.** Submitting a job
  application is an irreversible, outward-facing action taken in your name.
  Signing into a portal, entering personal data into a form, and clicking a
  final "Submit" must each be confirmed per application by a human — they cannot
  be automated blindly.
- **CAPTCHAs / bot-detection cannot be bypassed.** Many application flows gate
  submission behind exactly these.
- **Terms of Service.** Several job platforms prohibit automated submission.
  Mass auto-applying also damages your reputation with employers and can get
  accounts flagged.
- **Irreversibility.** You cannot un-send an application. A wrong or low-quality
  auto-submitted application is permanent.

The conclusion is not "impossible" — it's that **fully-autonomous submit is the
wrong goal.** The right goal is to remove all the tedious work *up to* the submit
click, and leave that click to you.

## Per-platform reality

| Platform | Application surface | Automatability |
|---|---|---|
| Greenhouse / Lever / Ashby | Structured hosted form; some fields prefillable via URL/query | Prefill + deep-link is feasible; final submit stays manual |
| SmartRecruiters / Workable / Recruitee | Structured hosted form | Similar — prefill feasible, submit manual |
| Workday | Multi-step **authenticated** flow, account required, heavy JS | Hardest; realistically manual |
| LinkedIn / Indeed "Easy Apply" | Auth-gated, aggressive bot-detection, ToS restrictions | Not advisable |

## Recommended phased design — "assisted apply"

Build the value without crossing the constraints:

**Phase 1 — Application package generator (safe, high value).**
For each matched job (already in the DB with score ≥ threshold), generate:
- a **tailored cover letter** and **short answers** to the common free-text
  questions ("why this company", "notice period", …), produced by the existing
  Gemini runner in [../src/extract.mjs](../src/extract.mjs) using `cv.md` /
  [../cv.yaml](../cv.yaml) plus the job's extracted text;
- a **prep sheet** (resume file to attach, links, salary expectation, work
  authorization) pulled from the CV;
- the **apply deep-link**.

Store these alongside the job (new `applications` table or files) and surface
them through the existing notify/email path. You open the link, paste/attach the
prepared materials, review, and submit. Nothing is auto-submitted; no
credentials are handled.

**Phase 2 — Guided browser prefill (optional, opt-in, interactive only).**
In an interactive session (never the unattended Cloud Run job), drive a browser
to open the application form and *prefill* known fields, then **stop and hand
control to you** for review + submit. This still requires you present for the
final click and for any login/CAPTCHA.

**Never:** store portal passwords, submit forms unattended, or run any of this
inside the nightly Cloud Run job.

## Where this would plug in

- Data: extend the schema in [../src/db.mjs](../src/db.mjs) with an
  `applications` table (job_id, cover_letter, answers_json, status, created_at).
- Generation: reuse the Gemini call path from
  [../src/extract.mjs](../src/extract.mjs); gate on `score.matched`.
- Delivery: extend [../src/notify.mjs](../src/notify.mjs) to include the package
  / link in the digest.
