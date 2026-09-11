import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS, buildCvProfile, skillsScore, titleScore, buildVocabulary, jdTerms,
  keywordBodyScore, semanticScore, entityDelta, seniorityLevel, yearsMin, gate, combine
} from '../src/scoring/formula.mjs';
import { canon } from '../src/scoring/ontology.mjs';
import { jdChunks, cvChunks, htmlToText, normKey } from '../src/scoring/text.mjs';

const CV = `
# Jane Candidate
**City** | jane@example.com

## Professional Experience
### AI Engineer | Acme
*Aug 2025 – Present*
  * Built agents with the Model Context Protocol (MCP) and the OpenAI Realtime API.
  * Benchmarked a Llama LLM against RL policies.

## Skills & Certifications
  * [cite_start]**Languages:** Java, Python, C++, JavaScript, SQL [cite: 44]
  * **Cloud & DevOps:** GCP, Docker, Kubernetes, Azure, Kafka, MongoDB
`;

// The real extraction for Parloa "Forward Deployed Engineer - US" (job 678).
const PARLOA = {
  skills: ['Python', 'TypeScript', 'Node.js', 'OpenAI', 'Microsoft Azure', 'Kubernetes', 'Docker', 'Terraform', 'MongoDB', 'MySQL', 'Redis', 'Kafka', 'MCP', 'APIs', 'LLMs'],
  entity_graph: {
    required_skills: ['Python', 'TypeScript', 'Kubernetes', 'Azure', 'Docker', 'Terraform', 'MongoDB', 'MySQL', 'Redis', 'Kafka'],
    tech_stack: ['Python', 'TypeScript', 'Node.js', 'OpenAI', 'Microsoft Azure', 'Kubernetes', 'Docker', 'Terraform', 'MongoDB', 'MySQL']
  }
};

const cv = buildCvProfile(CV);

test('canonicalisation folds aliases, plurals and punctuation', () => {
  assert.equal(canon('Google Cloud Platform'), canon('GCP'));
  assert.equal(canon('LLMs'), canon('large language models'));
  assert.equal(canon('Model Context Protocol'), canon('MCP'));
  assert.equal(normKey('CI/CD'), normKey('ci cd'));
});

test('skills score on the Parloa extraction', () => {
  const sk = skillsScore(PARLOA, cv, DEFAULTS.skills);
  // required: 6 exact + TypeScript (JavaScript), MySQL (SQL), Redis (MongoDB) related
  // at 0.5 each = 7.5 of 10 -> (7.5+0.6)/12
  assert.ok(Math.abs(sk.cov_required - 8.1 / 12) < 1e-9, `cov_required=${sk.cov_required}`);
  // other: Node.js related 0.5, OpenAI, MCP, LLMs exact = 3.5 of 4 -> (3.5+0.6)/6
  assert.ok(Math.abs(sk.cov_other - 4.1 / 6) < 1e-9, `cov_other=${sk.cov_other}`);
  assert.ok(Math.abs(sk.value - 0.6775) < 0.001);
  assert.deepEqual(sk.missing_required, ['Terraform']);
  assert.deepEqual(sk.related_required.sort(), ['MySQL', 'Redis', 'TypeScript']);
});

test('title tiers use whole phrases and split scraped concatenations', () => {
  const tiers = [{ weight: 1, patterns: ['AI Engineer'] }, { weight: 0.75, patterns: ['Software Engineer'] }, { weight: 0.6, patterns: ['Forward Deployed Engineer'] }];
  assert.equal(titleScore('Senior AI Engineer', tiers).value, 1);
  assert.equal(titleScore('Software EngineerSan Francisco, United States', tiers).value, 0.75);
  assert.equal(titleScore('Manager, Forward Deployed Engineering', tiers).value, 0);
});

test('keyword match rate credits literal hits fully and synonyms partially', () => {
  const text = 'You will build on Google Cloud with Python and Terraform. Python everywhere. Experience with Kubernetes.';
  const vocab = buildVocabulary([], []);
  const terms = jdTerms(text, vocab);
  const df = new Map([...terms.keys()].map((k) => [k, 1]));
  const kb = keywordBodyScore({ terms, extraction: null, company: 'Acme', df, corpusSize: 10, cv, cfg: DEFAULTS.keywords });
  assert.ok(kb.matched.includes('python'));
  assert.ok(kb.alias.includes('google cloud'), `alias=${kb.alias}`);
  assert.ok(kb.missing.includes('terraform'));
  assert.ok(kb.value > 0 && kb.value < 1);
});

test('ambiguous words are not scanned as keywords', () => {
  const terms = jdTerms('Ready to go to market and join the rest of the team', buildVocabulary([], []));
  assert.equal(terms.size, 0);
});

test('semantic calibration maps sims through tau_lo..tau_hi', () => {
  const cfg = { tau_lo: 0.55, tau_hi: 0.8 };
  assert.equal(semanticScore([[0.5, 1], [0.8, 1]], cfg), 0.5);
  assert.equal(semanticScore([], cfg), null);
});

test('seniority and years are read from title and text', () => {
  assert.equal(seniorityLevel('Senior Manager, Solutions', null), 'manager');
  assert.equal(seniorityLevel('Staff Software Engineer', null), 'staff');
  assert.equal(seniorityLevel('Software Engineer II', null), 'mid');
  assert.equal(seniorityLevel('Account Lead, Mid-Market', { seniority: 'Mid-Market' }), 'staff');
  assert.equal(seniorityLevel('Member of Technical Staff (Machine Learning Engineer)', null), 'unknown');
  assert.equal(seniorityLevel('Software Engineer I, Quality', null), 'junior');
  assert.equal(seniorityLevel('Software Engineer II', null), 'mid');
  assert.equal(yearsMin(null, 'You have 3-5 years of professional experience and 8+ years experience in Go'), 3);
  const d = entityDelta({ title: 'Senior AI Engineer', extraction: null, text: '4+ years of experience building LLM agents and RAG', cfg: { ...DEFAULTS.entity, your_years: 6, domains: ['rag', 'llm'] } });
  assert.equal(d.parts.seniority, 0.05);
  assert.equal(d.parts.years, 0.03);
  assert.equal(d.parts.domain, 0.02);
  assert.ok(Math.abs(d.value - 0.10) < 1e-9);
});

test('gates block negative titles and explicitly foreign locations only', () => {
  const opts = { negative: ['Sales'], allowed: ['Remote', 'US', 'United States', 'California'], excluded: ['France', 'Europe', 'UK'] };
  assert.equal(gate({ title: 'Sales Engineer', ...opts }).gated, true);
  assert.equal(gate({ title: 'Senior Forward Deployed Engineer (France)', jobLocation: 'Paris', ...opts }).gated, true);
  assert.equal(gate({ title: 'AI Engineer', jobLocation: 'Remote - Europe', ...opts }).gated, true);
  assert.equal(gate({ title: 'AI Engineer', jobLocation: 'New York, NY; London, UK', ...opts }).gated, false);
  assert.equal(gate({ title: 'AI Engineer', jobLocation: 'Boston, MA', ...opts }).gated, false);
  assert.equal(gate({ title: 'AI Engineer - join us', jobLocation: null, ...opts }).gated, false);
  assert.equal(gate({ title: 'Sr. ML Engineer', jobLocation: 'Toronto, ON, CA', ...opts, excluded: ['Toronto'] }).gated, true);
  assert.equal(gate({ title: 'AI Engineer', jobLocation: 'San Francisco, CA, or Remote within France or United States', ...opts }).gated, false);
  assert.equal(gate({ title: 'Research Counsel', jobLocation: 'San Francisco, CA', positive: ['AI Engineer'], ...opts }).reason, 'Title not a target role');
});

test('combine renormalises weights over available components', () => {
  const w = DEFAULTS.weights;
  const full = combine({ skills: 0.648, keywords: 0.60, semantic: 0.62, delta: 0, weights: w, minComponents: 2 });
  assert.equal(full.score, 61.9);
  assert.equal(full.confidence, 'full');
  const partial = combine({ skills: undefined, keywords: 0.6, semantic: 0.6, delta: 0.05, weights: w, minComponents: 2 });
  assert.equal(partial.score, 65);
  assert.equal(partial.confidence, 'partial');
  assert.equal(partial.enough, true);
});

test('JD chunking keeps requirements, weights sections, drops boilerplate', () => {
  const html = '&lt;h2&gt;About Acme&lt;/h2&gt;&lt;p&gt;We are a company that does many things for many people.&lt;/p&gt;'
    + '&lt;h3&gt;What you will do&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;Build retrieval pipelines for enterprise customers&lt;/li&gt;&lt;/ul&gt;'
    + '&lt;h3&gt;Requirements&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;Experience with Python and Go&lt;/li&gt;&lt;/ul&gt;'
    + '&lt;h3&gt;Nice to have&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;Shipped a voice agent to production users&lt;/li&gt;&lt;/ul&gt;'
    + '&lt;h3&gt;Benefits&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;Great health insurance and a generous 401(k) match&lt;/li&gt;&lt;/ul&gt;';
  const chunks = jdChunks(htmlToText(html));
  assert.deepEqual(chunks, [
    { text: 'Build retrieval pipelines for enterprise customers', weight: 0.7 },
    { text: 'Experience with Python and Go', weight: 1 },
    { text: 'Shipped a voice agent to production users', weight: 0.4 }
  ]);
});

test('CV chunks skip contact and date lines', () => {
  const chunks = cvChunks(CV);
  assert.ok(chunks.some((c) => c.startsWith('Built agents with the Model Context Protocol')));
  assert.ok(!chunks.some((c) => c.includes('jane@example.com')));
  assert.ok(!chunks.some((c) => /Aug 2025/.test(c)));
});
