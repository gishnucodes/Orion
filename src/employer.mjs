/**
 * Employer names for postings that arrive through aggregators.
 *
 * Kept apart from scan.mjs, which runs its pipeline on import, so the naming
 * rules can be unit-tested.
 */

// Hosts that are an applicant-tracking system rather than the employer's own
// site. For these the employer is named by the board slug, not the domain.
const ATS_HOST = /(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|recruitee\.com|myworkdayjobs\.com|gem\.com|getro\.com|breezy\.hr|bamboohr\.com|rippling\.com)$/;

/** Employer key from a posting URL: the ATS slug or tenant, else the domain's name label. */
function employerKey(url) {
  try {
    const { hostname, pathname } = new URL(url);
    const host = hostname.toLowerCase().replace(/^www\./, '');
    if (/myworkdayjobs\.com$/.test(host)) return host.split('.')[0];
    if (ATS_HOST.test(host)) return pathname.split('/').filter(Boolean)[0]?.toLowerCase() || null;
    const labels = host.split('.');
    return labels.length >= 2 ? labels[labels.length - 2] : labels[0];
  } catch {
    return null;
  }
}

/**
 * Name the employer from the posting URL when the aggregator's label is wrong.
 *
 * VC networks list jobs under the portfolio company they backed, even after an
 * acquisition: Getro files Microsoft roles under "Yammer" and "Citus Data", HPE
 * roles under "Nimble Storage". When the URL's employer key shares nothing with
 * the aggregator's name, the URL wins.
 */
export function companyFromUrl(url, fallback) {
  const key = employerKey(url);
  const name = String(fallback || '').trim();
  if (!key) return name || null;
  const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const k = norm(key);
  const n = norm(name);
  // Agreement on a short prefix is enough ("Snap Inc." / snapchat); an
  // acquired label shares nothing with its parent ("Yammer" / microsoft).
  if (n && (n.includes(k) || k.includes(n.slice(0, 4)))) return name;
  if (k.length <= 3) return k.toUpperCase();
  return k.charAt(0).toUpperCase() + k.slice(1);
}


/**
 * Recruiting agencies, staffing firms and job boards that post other
 * companies' roles under their own name. They surfaced once boards from
 * SmartRecruiters and Workable were imported (Collabera, KRG Technology,
 * Procom, "Ginas Tech Jobs"…); applying through them is not applying to the
 * employer. Matched on the company name or board slug.
 */
const STAFFING = new RegExp([
  // Generic words, but not an employer's own board ("Rubrik Job Board",
  // slug "nextdoor-jobs") and not ZipRecruiter, which hires engineers itself.
  'staffing', '(?<!zip)recruit', 'talent(?!soft)', 'headhunt', 'placement',
  // Job boards and feeds seen posing as employers.
  'tech jobs', 'job sauce', 'third-party job', 'job wrapping', 'invite-only job', '^jobs?$', '^job board$', 'flatgigs',
  // Named IT staffing firms.
  'resources? network', 'consultants group', 'procom', 'collabera', 'krg ?technolog', 'teksystems',
  'randstad', 'insight ?global', 'apex ?systems', 'robert ?half', 'kforce', 'cybercoders', 'jobot',
  'motion ?recruitment', 'huzzle', 'next ?step ?systems', '^usm$', 'hire ?quest', '^dice$'
].join('|'), 'i');

export function isStaffingAgency(name) {
  return STAFFING.test(String(name || '').trim());
}

/** "coperniq" -> "Coperniq", "red-hat" -> "Red Hat"; names that already have capitals are kept. */
export function prettyName(name) {
  const s = String(name || '').trim();
  if (!s || s !== s.toLowerCase()) return s;
  return s.split(/[-_\s]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
