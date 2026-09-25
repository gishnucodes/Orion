/**
 * Put answers into scanned fields (form-scan.mjs), one Playwright action per
 * control type. Works on the data-orion-field tags, so it is ATS-agnostic; the
 * adapters only decide where the form is and how to submit it.
 */
import { frameOf } from './form-scan.mjs';
import { pickOption } from './profile.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A short, slightly irregular pause between fields: React forms debounce
// validation, and a form filled in 50 ms reads as a bot to captcha scoring.
const settle = () => sleep(150 + Math.floor(Math.random() * 250));

const locFor = (page, field) => frameOf(page, field).locator(`[data-orion-field="${field.id}"]`);

/** Visible dropdown options after a combobox has been opened or typed into. */
async function visibleOptions(frame) {
  return frame.evaluate(() => {
    const els = [...document.querySelectorAll('[role="option"], .select__option, [class*="option"][id*="option"]')];
    return els
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .map((e) => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  });
}

async function clickOption(frame, optionText) {
  const opt = frame.locator('[role="option"], .select__option').filter({ hasText: optionText }).first();
  await opt.click({ timeout: 4000 });
}

/**
 * Open a combobox and read its options (for questions the ATS schema did not
 * describe). Long lists — country pickers — return null: those are filled by
 * typing and matching instead.
 */
export async function probeOptions(page, field) {
  const frame = frameOf(page, field);
  const el = locFor(page, field).first();
  try {
    await el.scrollIntoViewIfNeeded({ timeout: 3000 });
    await el.click({ timeout: 3000 });
    await sleep(500);
    const opts = await visibleOptions(frame);
    await el.press('Escape').catch(() => {});
    await sleep(150);
    return opts.length && opts.length <= 60 ? [...new Set(opts)] : null;
  } catch {
    return null;
  }
}

async function fillCombobox(page, field, value, { search } = {}) {
  const frame = frameOf(page, field);
  const el = locFor(page, field).first();
  await el.scrollIntoViewIfNeeded({ timeout: 3000 });
  await el.click({ timeout: 3000 });
  const typed = String(search || value).slice(0, 40);
  await el.fill('');
  await el.pressSequentially(typed, { delay: 35 });
  // Location autocompletes query a geocoder; give them time.
  const deadline = Date.now() + (field.kind === 'location' ? 6000 : 2500);
  let options = [];
  while (Date.now() < deadline) {
    await sleep(300);
    options = await visibleOptions(frame);
    if (options.length) break;
  }
  if (!options.length) throw new Error(`no options appeared for "${typed}"`);
  const choice = field.kind === 'location'
    ? options.find((o) => o.toLowerCase().includes(String(search || value).toLowerCase())) || options[0]
    : pickOption(options, value);
  if (!choice) throw new Error(`no option matches "${value}" (saw: ${options.slice(0, 5).join(' | ')})`);
  await clickOption(frame, choice);
  return choice;
}

function toDateInput(value) {
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[2]}/${m[3]}/${m[1]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
  return null;
}

/**
 * Fill one field. `answer` is { value, search? } where value is a string, an
 * option text (choice fields), an array of option texts (checkboxes), or a
 * file path (file fields). Returns the value actually set; throws on failure.
 */
export async function fillField(page, field, answer) {
  const value = answer.value;
  const el = locFor(page, field);
  switch (field.kind) {
    case 'text': case 'email': case 'tel': case 'url': case 'number': case 'textarea': {
      const input = el.first();
      await input.scrollIntoViewIfNeeded({ timeout: 3000 });
      await input.fill(String(value));
      await input.dispatchEvent('blur').catch(() => {});
      return String(value);
    }
    case 'date': {
      const d = toDateInput(value);
      if (!d) throw new Error(`not a date: "${value}"`);
      const input = el.first();
      await input.scrollIntoViewIfNeeded({ timeout: 3000 });
      await input.click();
      await input.fill(d);
      await input.press('Escape').catch(() => {});
      await input.press('Tab').catch(() => {});
      return d;
    }
    case 'select': {
      const [picked] = await el.first().selectOption({ label: String(value) });
      return picked ? String(value) : '';
    }
    case 'combobox': case 'location':
      return fillCombobox(page, field, value, answer);
    case 'radio': case 'yesno': {
      const idx = (field.options || []).indexOf(String(value));
      if (idx < 0) throw new Error(`"${value}" is not an option`);
      const opt = frameOf(page, field).locator(`[data-orion-field="${field.id}"][data-orion-opt="${idx}"]`).first();
      await opt.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      if (field.kind === 'radio') await opt.check({ force: true });
      else await opt.click();
      return String(value);
    }
    case 'checkbox': {
      const on = value === true || /^(yes|true|checked|agree)/i.test(String(value));
      await el.first().setChecked(on, { force: true });
      return on ? 'checked' : '';
    }
    case 'checkboxes': {
      const wanted = new Set((Array.isArray(value) ? value : [value]).map(String));
      const opts = field.options || [];
      for (let i = 0; i < opts.length; i += 1) {
        const box = frameOf(page, field).locator(`[data-orion-field="${field.id}"][data-orion-opt="${i}"]`).first();
        await box.setChecked(wanted.has(opts[i]), { force: true });
      }
      return [...wanted];
    }
    case 'file': {
      await el.first().setInputFiles(String(value));
      await sleep(1500); // upload + parse spinner
      return String(value);
    }
    default:
      throw new Error(`unsupported field kind: ${field.kind}`);
  }
}

/**
 * Fill every answered field in page order. Returns { filled: [id], failed:
 * [{ id, label, error }] }. A failure never aborts the rest of the form.
 */
export async function fillAll(page, fields, answers, log = () => {}) {
  const filled = [];
  const failed = [];
  for (const field of fields) {
    const answer = answers.get(field.id);
    if (!answer || answer.value === null || answer.value === undefined || answer.skip) continue;
    try {
      const set = await fillField(page, field, answer);
      filled.push(field.id);
      log(`  ✓ ${field.label.slice(0, 60)} → ${Array.isArray(set) ? set.join(', ') : String(set).slice(0, 60)}`);
    } catch (err) {
      failed.push({ id: field.id, label: field.label, error: err.message.split('\n')[0] });
      log(`  ✗ ${field.label.slice(0, 60)}: ${err.message.split('\n')[0]}`);
    }
    await settle();
  }
  return { filled, failed };
}

/** Visible validation errors on the page (after a fill or a failed submit). */
export async function formErrors(page) {
  return page.mainFrame().evaluate(() => {
    const out = [];
    for (const e of document.querySelectorAll('[class*="error"], [role="alert"], .invalid-feedback, [id$="-error"]')) {
      const r = e.getBoundingClientRect();
      const t = (e.innerText || '').replace(/\s+/g, ' ').trim();
      if (r.width > 0 && r.height > 0 && t && t.length < 200 && !/captcha/i.test(t)) out.push(t);
    }
    return [...new Set(out)].slice(0, 10);
  }).catch(() => []);
}
