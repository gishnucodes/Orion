/**
 * The submit gate: a pure function deciding whether the agent may click
 * Submit by itself. Every condition must hold; anything else pauses for you.
 * Kept pure (no page, no clock) so the whole truth table is unit-tested.
 */

/** ATSes whose DOM filling is verified field-by-field; the only auto-submit candidates. */
export const AUTO_SUBMIT_ATS = new Set(['greenhouse', 'lever', 'ashby']);

/**
 * @param {object} s
 * @param {'shadow'|'review'|'confident'} s.mode
 * @param {string} s.ats          adapter name, or 'generic'/'workday'
 * @param {'dom'|'cu'} s.engine
 * @param {object[]} s.missing    required fields still empty
 * @param {object[]} s.review     answers not confident enough (answer.mjs)
 * @param {object[]} s.failed     fields the filler could not set
 * @param {string[]} s.formErrors visible validation errors
 * @param {boolean} s.captchaChallenge  a captcha challenge/checkbox is visible
 * @param {string} s.company
 * @param {string[]} s.neverAutoSubmit
 * @param {number} s.submittedToday
 * @param {number} s.dailyCap
 * @returns {{ action: 'submit'|'pause'|'hold', reasons: string[] }}
 *   submit  click Submit now
 *   pause   stop and ask you (something needs a human)
 *   hold    would submit, but the mode forbids it (shadow) — record as ready
 */
export function decide(s) {
  const reasons = [];
  if (s.missing?.length) reasons.push(`${s.missing.length} required field(s) unanswered`);
  if (s.failed?.length) reasons.push(`${s.failed.length} field(s) could not be filled`);
  if (s.review?.length) reasons.push(`${s.review.length} answer(s) need review`);
  if (s.formErrors?.length) reasons.push(`form shows errors: ${s.formErrors.slice(0, 2).join('; ')}`);
  if (s.captchaChallenge) reasons.push('a CAPTCHA challenge is showing');
  if (s.engine !== 'dom') reasons.push('Computer Use applications are always reviewed');
  if (!AUTO_SUBMIT_ATS.has(s.ats)) reasons.push(`${s.ats} is not on the auto-submit allowlist`);
  const blocked = (s.neverAutoSubmit || []).some((c) => c && s.company && c.toLowerCase() === s.company.toLowerCase());
  if (blocked) reasons.push(`${s.company} is in never_auto_submit`);
  if ((s.submittedToday ?? 0) >= (s.dailyCap ?? 0)) reasons.push(`daily cap reached (${s.submittedToday}/${s.dailyCap})`);

  // A human is needed if the form itself is not complete and clean; mode only
  // matters once it is.
  const needsHuman = reasons.length > 0;
  if (s.mode === 'review') return { action: 'pause', reasons: [...reasons, 'review mode'] };
  if (needsHuman) {
    // In shadow mode, policy-only blockers (cap, allowlist) are not worth a
    // pause: nothing would be submitted anyway.
    const formProblems = s.missing?.length || s.failed?.length || s.review?.length || s.formErrors?.length || s.captchaChallenge || s.engine !== 'dom';
    if (s.mode === 'shadow' && !formProblems) return { action: 'hold', reasons };
    return { action: 'pause', reasons };
  }
  if (s.mode === 'shadow') return { action: 'hold', reasons: ['shadow mode — would submit'] };
  return { action: 'submit', reasons: ['all checks passed'] };
}
