/**
 * Text normalisation shared by every v2 scoring component.
 *
 * The one rule that matters: the JD, the CV and every vocabulary term go through
 * the same `normKey`, so "LLMs", "llm" and "LLM." compare equal and "CI/CD" and
 * "ci cd" do too. Matching is done on token n-grams rather than regexes, which
 * keeps a 5,000-job corpus against a ~2,000-term vocabulary to a few seconds.
 */
import crypto from 'node:crypto';

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', bull: '•', middot: '·'
};

export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/**
 * HTML to line-structured plain text. Block elements become newlines so that
 * section headers ("Requirements") stay on their own line for chunking.
 * Greenhouse double-escapes its `content`, hence the decode before parsing.
 */
export function htmlToText(html) {
  if (!html) return '';
  let s = String(html);
  if (/&lt;\/?[a-z]/i.test(s)) s = decodeEntities(s);
  s = s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|section|header)>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<h[1-6][^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return tidyText(decodeEntities(s));
}

export function tidyText(text) {
  return String(text ?? '')
    .replace(/\r/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stem(token) {
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss') && /^[a-z]+$/.test(token)) {
    return token.slice(0, -1);
  }
  return token;
}

/** Lowercased, punctuation-split, plural-folded tokens. Keeps c++, c#, node.js. */
export function tokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .split(' ')
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean)
    .map(stem);
}

export function normKey(text) {
  return tokens(text).join(' ');
}

/** Counts of every 1..maxN token n-gram, keyed by normKey form. */
export function ngramCounts(text, maxN = 4) {
  const toks = tokens(text);
  const counts = new Map();
  for (let i = 0; i < toks.length; i += 1) {
    let key = '';
    for (let n = 1; n <= maxN && i + n <= toks.length; n += 1) {
      key = n === 1 ? toks[i] : `${key} ${toks[i + n - 1]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/** Split "EngineerSan Francisco" style concatenations left by scraped titles. */
export function splitCamelJoins(text) {
  return String(text ?? '').replace(/([a-z])([A-Z])/g, '$1 $2');
}

export function sha1(text) {
  return crypto.createHash('sha1').update(String(text ?? '')).digest('hex');
}

/** CV markdown with export artifacts ([cite_start], [cite: 1]) and markup removed. */
export function cleanCv(cvText) {
  return String(cvText ?? '')
    .replace(/\[cite_start\]/gi, '')
    .replace(/\[cite:[^\]]*\]/gi, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/^\s*-{3,}\s*$/gm, '');
}

/**
 * CV evidence chunks for semantic matching: bullets, role headings and skills
 * lines. Contact details and education boilerplate carry no job-fit signal.
 */
export function cvChunks(cvText) {
  const lines = cleanCv(cvText).split('\n').map((l) => l.trim()).filter(Boolean);
  const chunks = [];
  let section = '';
  for (const line of lines) {
    const heading = line.match(/^(#+)\s*(.+)$/);
    if (heading) {
      // Level 1 is the name/contact block; level 2 opens a CV section.
      if (heading[1].length === 1) section = '';
      else if (heading[1].length === 2) section = heading[2].toLowerCase();
      else if (!/education/.test(section)) chunks.push(heading[2].replace(/\|/g, ',').trim());
      continue;
    }
    if (!section || /award|education/.test(section) && !/course|research/i.test(line)) continue;
    const text = line.replace(/^[*•-]\s*/, '').replace(/^\*|\*$/g, '').trim();
    const words = text.split(/\s+/).length;
    // Date lines ("Aug 2025 – Present") are not evidence of anything.
    if (words >= 4 && !(words <= 6 && /\b(19|20)\d{2}\b/.test(text))) chunks.push(text);
  }
  return chunks;
}

const HEADER_RULES = [
  // Dropped first: once a posting reaches benefits/EEO text, nothing after is fit signal.
  { section: 'drop', re: /^(benefits|perks|compensation|salary|pay (range|transparency)|total rewards|what we offer|why join|life at|about (us|the company|the team)|who we are|our (values|mission|culture)|equal (employment )?opportunit|eeo|privacy|accommodations?|how we work|the interview|interview process|location( policy)?|logistics)\b/i },
  { section: 'nice', re: /^(nice[- ]to[- ]haves?|preferred|bonus|pluses|it'?s a plus|good to have|strong candidates may also|you might also|extra credit)/i },
  { section: 'required', re: /^(requirements|qualifications|minimum qualifications|basic qualifications|required|must[- ]haves?|what (you'?ll|you will) (need|bring)|what we'?re looking for|who you are|about you|you (have|bring|are|may be a good fit)|skills|experience|your background|you'?ll thrive|ideal candidate)/i },
  { section: 'responsibilities', re: /^(responsibilities|what (you'?ll|you will) do|the role|about the role|in this role|your (impact|role)|day[- ]to[- ]day|key duties|you will|what the job involves|the opportunity)/i },
  // Company intro blocks ("About Anthropic") — checked last so "About the role" wins above.
  { section: 'drop', re: /^about [a-z0-9&.' -]{2,30}$/i }
];

/**
 * A line is a section header only when it is short and the header phrase is
 * most of it — otherwise "Experience with Python and Go" would be eaten as the
 * "Experience" header.
 */
function headerRule(seg) {
  const bare = seg.replace(/[:?]\s*$/, '').trim();
  if (bare.split(/\s+/).length > 6) return null;
  for (const rule of HEADER_RULES) {
    const m = bare.match(rule.re);
    if (m && m[0].length >= bare.length * 0.5) return rule;
  }
  return null;
}

const BOILERPLATE = /(equal opportunity|without regard to|reasonable accommodation|401\(?k\)?|health (insurance|benefits)|paid time off|parental leave|visa sponsorship is|e-verify|pay range|salary range|base salary|\$\d{2,3},?\d{3}|privacy (policy|notice)|background check)/i;

export const SECTION_WEIGHTS = { required: 1.0, responsibilities: 0.7, nice: 0.4, other: 0.5 };

function splitSegments(text) {
  const lines = tidyText(text).split('\n');
  const segments = [];
  for (const line of lines) {
    // Playwright page text arrives as one long line; fall back to sentences/bullets.
    const parts = line.length > 400
      ? line.split(/(?<=[.!?])\s+(?=[A-Z•])|\s•\s/)
      : [line];
    for (const part of parts) {
      const words = part.trim().split(/\s+/).filter(Boolean);
      for (let i = 0; i < words.length; i += 60) segments.push(words.slice(i, i + 60).join(' '));
    }
  }
  return segments.filter(Boolean);
}

/**
 * Walk a posting and label every segment with its section, dropping company
 * intro, benefits and EEO text. Shared by semantic chunking and keyword counting
 * so neither sees "equity" or "401(k)" as a job requirement.
 */
export function jdSegments(text) {
  let section = 'other';
  const out = [];
  for (const raw of splitSegments(text)) {
    let seg = raw.replace(/^[•*\-–]\s*/, '').trim();
    const rule = headerRule(seg);
    if (rule) {
      section = rule.section;
      continue;
    }
    // Inline header: "Requirements: 5+ years of ..." (common in flattened page text).
    const inline = seg.match(/^([^:]{3,40}):\s+(.+)$/);
    const inlineRule = inline && headerRule(inline[1]);
    if (inlineRule) {
      // "Location: Remote" drops only its own line, not everything after it.
      if (inlineRule.section === 'drop') continue;
      section = inlineRule.section;
      seg = inline[2];
    }
    if (section === 'drop' || BOILERPLATE.test(seg)) continue;
    out.push({ text: seg, section });
  }
  return out;
}

/** Posting text with boilerplate removed, for keyword counting. */
export function jdKeywordText(text) {
  return jdSegments(text).map((s) => s.text).join('\n');
}

/**
 * JD requirement chunks with section weights. Each chunk is roughly one bullet
 * or sentence; fragments under 5 words carry too little meaning to embed. The
 * list is capped so a 20-page posting cannot dominate the embedding budget.
 */
export function jdChunks(text, maxChunks = 40) {
  const out = jdSegments(text)
    .filter((s) => s.text.split(/\s+/).length >= 5)
    .map((s) => ({ text: s.text, weight: SECTION_WEIGHTS[s.section] }));
  if (out.length <= maxChunks) return out;
  return out
    .map((c, i) => ({ ...c, i }))
    .sort((a, b) => b.weight - a.weight || a.i - b.i)
    .slice(0, maxChunks)
    .sort((a, b) => a.i - b.i)
    .map(({ text: t, weight }) => ({ text: t, weight }));
}
