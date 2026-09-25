/**
 * Per-ATS knowledge the generic scanner/filler cannot infer: where the
 * application form lives, extra field metadata, how to submit, and what
 * success looks like. Jobs with no adapter (Workday, generic career sites) go
 * to the Computer Use engine instead.
 */
const SUCCESS_TEXT = /thank you for (applying|your application|your interest)|application (has been |was )?(submitted|received)|we('ve| have) received your application|successfully submitted|application complete/i;
const CLOSED_TEXT = /no longer (accepting|available|open)|job (is )?not found|position (has been )?(filled|closed)|this job (has )?(expired|closed)|page (you('re| are) looking for )?(can('|no)t be found|not found)/i;

async function bodyText(page) {
  return page.mainFrame().evaluate(() => document.body?.innerText || '').catch(() => '');
}

// ---------------------------------------------------------------- Greenhouse

/** Board token for a Greenhouse job: from the URL, else from portals.yml. */
export function greenhouseIds(job, portals) {
  const url = job.url || '';
  let m = url.match(/greenhouse\.io\/(?:embed\/job_app\?.*for=)?([^/?#&]+)\/jobs\/(\d+)/);
  if (m) return { token: m[1], jobId: m[2] };
  m = url.match(/[?&](?:for=([^&]+)&)?(?:gh_jid|token)=(\d+)/);
  const jobId = m?.[2] || url.match(/[?&]gh_jid=(\d+)/)?.[1];
  if (!jobId) return null;
  const company = (portals?.tracked_companies || []).find((c) => c.name === job.company);
  const token = m?.[1] || company?.careers_url?.match(/greenhouse\.io\/([^/?#]+)/)?.[1];
  return token ? { token, jobId } : null;
}

const greenhouse = {
  name: 'greenhouse',
  matches: (job) => job.source === 'greenhouse' || /greenhouse\.io|gh_jid=/.test(job.url || ''),
  async applyUrl(job, { portals }) {
    const ids = greenhouseIds(job, portals);
    if (!ids) throw new Error('cannot resolve Greenhouse board token / job id');
    // The embed form renders the same questions for every board, including
    // companies whose public listing lives on their own domain (gh_jid=…).
    return `https://job-boards.greenhouse.io/embed/job_app?for=${ids.token}&token=${ids.jobId}`;
  },
  /**
   * The public job API describes every question — exact options for the
   * react-select comboboxes, which the DOM only reveals when opened.
   */
  async enrich(job, fields, { portals }) {
    const ids = greenhouseIds(job, portals);
    if (!ids) return fields;
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${ids.token}/jobs/${ids.jobId}?questions=true`);
    if (!res.ok) return fields;
    const data = await res.json();
    const byName = new Map();
    const add = (q) => {
      for (const f of q.fields || []) {
        byName.set(f.name, { label: q.label, required: !!q.required, options: (f.values || []).map((v) => v.label) });
      }
    };
    (data.questions || []).forEach(add);
    (data.location_questions || []).forEach(add);
    for (const block of data.compliance || []) (block.questions || []).forEach(add);
    for (const q of data.demographic_questions?.questions || []) {
      byName.set(String(q.id), { label: q.label, required: !!q.required, options: (q.answer_options || []).map((o) => o.label) });
    }
    return fields.map((f) => {
      const meta = byName.get(f.domId) || byName.get(f.name);
      if (!meta) return f;
      return {
        ...f,
        label: f.label || meta.label,
        required: f.required || meta.required,
        options: meta.options.length ? meta.options : f.options
      };
    });
  },
  submitSelector: 'button[type="submit"]:has-text("Submit"), button:has-text("Submit application")',
  async isSuccess(page) {
    return /\/confirmation|application_confirmation/.test(page.url()) || SUCCESS_TEXT.test(await bodyText(page));
  }
};

// --------------------------------------------------------------------- Lever

const lever = {
  name: 'lever',
  matches: (job) => job.source === 'lever' || /jobs\.lever\.co/.test(job.url || ''),
  async applyUrl(job) {
    const m = (job.url || '').match(/jobs\.lever\.co\/([^/]+)\/([0-9a-f-]{36})/i);
    if (!m) throw new Error('cannot parse Lever posting URL');
    return `https://jobs.lever.co/${m[1]}/${m[2]}/apply`;
  },
  async enrich(job, fields) {
    return fields;
  },
  submitSelector: '#btn-submit, button:has-text("Submit application")',
  async isSuccess(page) {
    return /\/thanks/.test(page.url()) || SUCCESS_TEXT.test(await bodyText(page));
  }
};

// --------------------------------------------------------------------- Ashby

const ashby = {
  name: 'ashby',
  matches: (job) => job.source === 'ashby' || /ashbyhq\.com/.test(job.url || ''),
  async applyUrl(job) {
    const m = (job.url || '').match(/jobs\.ashbyhq\.com\/([^/]+)\/([0-9a-f-]{36})/i);
    if (!m) throw new Error('cannot parse Ashby posting URL');
    return `https://jobs.ashbyhq.com/${m[1]}/${m[2]}/application`;
  },
  async enrich(job, fields) {
    // Ashby renders the system name field as "Name"/"Legal Name"; nothing else
    // needs outside metadata — yes/no and radio options are in the DOM.
    return fields;
  },
  submitSelector: 'button.ashby-application-form-submit-button, button:has-text("Submit Application")',
  async isSuccess(page) {
    return SUCCESS_TEXT.test(await bodyText(page));
  }
};

export const ADAPTERS = [greenhouse, lever, ashby];

export function pickAdapter(job) {
  return ADAPTERS.find((a) => a.matches(job)) || null;
}

/** The posting is gone (closed, 404) — nothing to apply to. */
export async function isClosed(page) {
  const text = await bodyText(page);
  return text.length < 4000 && CLOSED_TEXT.test(text);
}

export { SUCCESS_TEXT };
