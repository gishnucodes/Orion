/**
 * Read an application form into a flat list of questions, in any frame.
 *
 * The scanner runs inside the page (frame.evaluate) and tags every control it
 * reports with data-orion-field="fN" (radio/yes-no/checkbox options also get
 * data-orion-opt="i"), so filling and later re-scans address the same element
 * without re-deriving selectors. Tags are reused across scans, which is what
 * lets learn.mjs diff a before/after snapshot field by field.
 *
 * Field shape:
 *   { id, domId, name, label, description, kind, required, options, value,
 *     sensitive, frameUrl }
 * kind: text | email | tel | url | number | textarea | date | select | combobox
 *       | location | radio | yesno | checkbox | checkboxes | file
 */

/* The in-page half. Must be self-contained: it is serialized into the page. */
function scanInPage() {
  const seqKey = '__orionFieldSeq';
  window[seqKey] = window[seqKey] || 0;
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').replace(/[*✱]\s*$/, '').trim();
  const text = (el) => (el ? clean(el.innerText || el.textContent) : '');
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
  };
  const tag = (el) => {
    let id = el.getAttribute('data-orion-field');
    if (!id) {
      window[seqKey] += 1;
      id = `f${window[seqKey]}`;
      el.setAttribute('data-orion-field', id);
    }
    return id;
  };
  const CONTAINER = [
    '.ashby-application-form-field-entry', '.application-question', '.application-field',
    '.field-wrapper', '.select__container', '.text-input-wrapper', '.checkbox__wrapper',
    'fieldset', '[data-automation-id^="formField"]', '.form-group', '.form-field', '.field', 'li'
  ].join(', ');
  const QUESTION_LABEL = 'legend, .ashby-application-form-question-title, .application-label, label, [class*="question-title"], [class*="label"]';

  function containerOf(el) {
    return el.closest(CONTAINER);
  }
  function labelFor(el) {
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      const t = labelled.split(/\s+/).map((id) => text(document.getElementById(id))).filter(Boolean).join(' ');
      if (t) return t;
    }
    if (el.labels && el.labels.length) {
      const t = text(el.labels[0]);
      if (t) return t;
    }
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const c = containerOf(el);
    if (c) {
      const l = c.querySelector(QUESTION_LABEL);
      if (l && !l.contains(el)) {
        const t = text(l);
        if (t) return t;
      }
    }
    return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.name || '');
  }
  function groupLabel(el) {
    const fs = el.closest('fieldset');
    if (fs) {
      const lg = fs.querySelector('legend');
      if (lg) return text(lg);
    }
    const c = containerOf(el.parentElement || el);
    if (c) {
      const l = c.querySelector('legend, .ashby-application-form-question-title, .application-label, [class*="question-title"], label:not(:has(input))');
      if (l) return text(l);
    }
    return '';
  }
  function optionLabel(input) {
    if (input.labels && input.labels.length) return text(input.labels[0]);
    const wrap = input.closest('label');
    if (wrap) return text(wrap);
    const sib = input.nextElementSibling;
    if (sib) return text(sib);
    return clean(input.value);
  }
  function descriptionFor(el) {
    const c = containerOf(el);
    const d = c && c.querySelector('.ashby-application-form-question-description, [class*="description"], .help-text, .field-hint');
    return d ? text(d).slice(0, 400) : '';
  }
  function isRequired(el, label) {
    if (el.required || el.getAttribute('aria-required') === 'true') return true;
    const c = containerOf(el);
    if (c && c.querySelector('[class*="required"], .required, abbr[title="required"]')) return true;
    return /[*✱]/.test(label || '') || (el.labels && el.labels[0] && /[*✱]/.test(el.labels[0].textContent));
  }
  function rawLabel(el) {
    return (el.labels && el.labels[0] && el.labels[0].textContent) || '';
  }
  const SENSITIVE = /password|passcode|\bssn\b|social security|card number|credit card|cvv|cvc|routing|bank account|account number|\bpin\b/i;

  const fields = [];
  const seenGroups = new Set();
  const push = (f) => {
    f.sensitive = SENSITIVE.test(f.label) || f.inputType === 'password';
    delete f.inputType;
    fields.push(f);
  };

  // 1. Yes/No button groups (Ashby) — before generic buttons are ignored.
  for (const group of document.querySelectorAll('.ashby-application-form-input-yesno, [class*="yesno"]')) {
    const buttons = [...group.querySelectorAll('button')];
    if (buttons.length < 2 || !visible(group)) continue;
    const id = tag(group);
    buttons.forEach((b, i) => { b.setAttribute('data-orion-field', id); b.setAttribute('data-orion-opt', String(i)); });
    const label = groupLabel(group);
    const pressed = buttons.find((b) => b.getAttribute('aria-pressed') === 'true' || /selected|active/i.test(b.className));
    const c = containerOf(group);
    push({
      id, domId: '', name: '', label, description: descriptionFor(group), kind: 'yesno',
      required: !!(c && c.querySelector('[class*="required"]')) || /[*✱]/.test(label),
      options: buttons.map((b) => text(b)), value: pressed ? text(pressed) : ''
    });
  }

  const controls = document.querySelectorAll('input, textarea, select, [role="combobox"]:not(input)');
  for (const el of controls) {
    if (el.closest('[data-orion-field].ashby-application-form-input-yesno')) continue;
    const tagName = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || (tagName === 'input' ? 'text' : tagName)).toLowerCase();
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
    if (el.name === 'g-recaptcha-response' || el.name === 'h-captcha-response' || /captcha/i.test(el.id || '')) continue;
    if (el.closest('.iti__country-list, .iti__dropdown-content')) continue;

    if (type === 'radio' || type === 'checkbox') {
      const name = el.name || '';
      const siblings = name
        ? [...document.querySelectorAll(`input[type="${type}"][name="${CSS.escape(name)}"]`)]
        : [el];
      if (type === 'checkbox' && siblings.length === 1) {
        if (!visible(el) && !visible(el.closest('label') || el.parentElement)) continue;
        const id = tag(el);
        const label = optionLabel(el) || labelFor(el);
        const gl = groupLabel(el);
        push({
          id, domId: el.id, name, label: gl && gl !== label ? `${gl} — ${label}` : label,
          description: descriptionFor(el), kind: 'checkbox', required: isRequired(el, gl || label),
          options: null, value: el.checked ? 'checked' : '', inputType: type
        });
        continue;
      }
      const key = `${type}:${name}`;
      if (seenGroups.has(key)) continue;
      seenGroups.add(key);
      if (!siblings.some((s) => visible(s) || visible(s.closest('label') || s.parentElement))) continue;
      const id = tag(siblings[0]);
      siblings.forEach((s, i) => { s.setAttribute('data-orion-field', id); s.setAttribute('data-orion-opt', String(i)); });
      const options = siblings.map(optionLabel);
      const checked = siblings.filter((s) => s.checked).map(optionLabel);
      const label = groupLabel(siblings[0]) || labelFor(siblings[0]);
      push({
        id, domId: siblings[0].id, name, label, description: descriptionFor(siblings[0]),
        kind: type === 'radio' ? 'radio' : 'checkboxes',
        required: siblings.some((s) => s.required) || isRequired(siblings[0], label),
        options, value: type === 'radio' ? (checked[0] || '') : checked, inputType: type
      });
      continue;
    }

    if (type === 'file') {
      let label = labelFor(el);
      // Upload widgets label the input with their button ("Attach"); the
      // question ("Resume/CV", "Cover Letter") sits in a nearby label element.
      if (!label || /^(attach|upload|choose|browse|drop)/i.test(label)) {
        for (let up = el.parentElement, i = 0; up && i < 5; up = up.parentElement, i += 1) {
          const l = [...up.querySelectorAll('[id*="label"], [class*="label"], label, legend')]
            .filter((n) => !(n.htmlFor && n.htmlFor !== el.id))
            .map(text).find((t) => t && !/^(attach|upload|choose|browse|drop|or$|enter manually|dropbox|google drive|accepted file)/i.test(t));
          if (l) { label = l; break; }
        }
      }
      const c = containerOf(el);
      // Ashby's "autofill from resume" dropzone is a label-less file input
      // outside any question container; the real resume field has a label.
      if (!label && !c) continue;
      const id = tag(el);
      const uploaded = c ? /\.(pdf|docx?|txt|rtf)\b/i.test(text(c)) : false;
      push({
        id, domId: el.id, name: el.name || '', label: label || (c ? text(c.querySelector(QUESTION_LABEL)) : ''),
        description: '', kind: 'file', required: isRequired(el, label), options: null,
        value: el.files && el.files.length ? el.files[0].name : (uploaded ? 'uploaded' : ''), inputType: type
      });
      continue;
    }

    if (!visible(el)) continue;
    const id = tag(el);
    const label = labelFor(el);
    const base = {
      id, domId: el.id || '', name: el.name || '', label, description: descriptionFor(el),
      required: isRequired(el, rawLabel(el) || label), options: null, inputType: type
    };

    if (tagName === 'select') {
      const opts = [...el.options].filter((o) => o.value !== '' && !/^(select|choose|--|please select)/i.test(o.text.trim()));
      push({ ...base, kind: 'select', options: opts.map((o) => clean(o.text)), value: el.selectedIndex > 0 || (el.value && opts.some((o) => o.selected)) ? clean(el.options[el.selectedIndex]?.text) : '' });
      continue;
    }
    if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list') {
      const c = el.closest('.select__container, .select, [class*="select"], [class*="autocomplete"], .field-wrapper') || el.parentElement;
      const single = c && c.querySelector('[class*="single-value"], [class*="singleValue"], [class*="multi-value__label"]');
      const isLocation = (/\blocation\b|\bcity\b|where are you (currently )?(located|based)/i.test(label)
        && !/relocat/i.test(label) && label.length < 80) || /location/i.test(el.className + ' ' + el.id);
      push({ ...base, kind: isLocation ? 'location' : 'combobox', value: single ? text(single) : clean(el.value) });
      continue;
    }
    if (tagName === 'textarea') {
      push({ ...base, kind: 'textarea', value: el.value });
      continue;
    }
    const isDate = type === 'date' || /date/i.test(el.className) || /datepicker/i.test((el.closest('[class*="datepicker"]') || {}).className || '');
    const kind = isDate ? 'date' : (['email', 'tel', 'url', 'number', 'password'].includes(type) ? type : 'text');
    push({ ...base, kind: kind === 'password' ? 'text' : kind, value: el.value });
  }
  return fields;
}

/** Scan every frame except known third-party widgets (captchas, LinkedIn). */
export async function scanForm(page) {
  const out = [];
  for (const frame of page.frames()) {
    const url = frame.url();
    if (/recaptcha|hcaptcha|turnstile|challenges\.cloudflare|linkedin\.com|googleapis\.com\/static\/proxy/i.test(url)) continue;
    if (frame !== page.mainFrame() && (!url || url === 'about:blank')) continue;
    let fields = [];
    try {
      fields = await frame.evaluate(scanInPage);
    } catch {
      continue; // frame navigated or detached mid-scan
    }
    for (const f of fields) out.push({ ...f, frameUrl: frame === page.mainFrame() ? '' : url });
  }
  return out;
}

/** The frame a scanned field lives in. */
export function frameOf(page, field) {
  if (!field.frameUrl) return page.mainFrame();
  return page.frames().find((f) => f.url() === field.frameUrl) || page.mainFrame();
}

export const isEmptyValue = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
