import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGazetteer, extractSkills } from '../src/scoring/gazetteer.mjs';

/** A labelled extraction, in the shape extract.mjs writes. */
const labelled = (skills, required = []) => ({
  skills,
  entity_graph: { required_skills: required, nice_to_have_skills: [], tech_stack: [] }
});

// "python" appears in 3 postings, "kubernetes" in 3, "acmeinternaltool" in 1.
const CORPUS = [
  labelled(['Python', 'Kubernetes'], ['Python']),
  labelled(['python', 'Kubernetes', 'AcmeInternalTool']),
  labelled(['Python', 'kubernetes', 'API']),
  labelled(['Rust'])
];

test('vocabulary needs a term in several postings, not several mentions', () => {
  const gaz = buildGazetteer(CORPUS, { minJobs: 3 });
  const terms = gaz.patterns.map((p) => p.term);
  assert.ok(terms.includes('python'));
  assert.ok(terms.includes('kubernetes'));
  // One posting's internal tool name is noise, not a skill.
  assert.ok(!terms.includes('acmeinternaltool'));
  // "rust" is real but under the floor in this corpus.
  assert.ok(!terms.includes('rust'));
});

test('generic terms never enter the vocabulary', () => {
  // "api" is in GENERIC_TERMS; it appears once here but would survive any floor
  // of 1, so the filter — not the frequency cut — has to be what removes it.
  const gaz = buildGazetteer(CORPUS, { minJobs: 1 });
  assert.ok(!gaz.patterns.map((p) => p.term).includes('api'));
});

test('extra terms join the vocabulary regardless of frequency', () => {
  const gaz = buildGazetteer(CORPUS, { minJobs: 3, extraTerms: ['agentic'] });
  assert.ok(gaz.patterns.map((p) => p.term).includes('agentic'));
});

test('requirements section separates required skills from the rest', () => {
  const gaz = buildGazetteer(CORPUS, { minJobs: 3 });
  const posting = [
    'About the role',
    'You will work on our platform, which runs on Kubernetes.',
    'Requirements:',
    '5+ years of Python experience'
  ].join('\n');
  const found = extractSkills(posting, gaz);
  assert.deepEqual(found.required_skills, ['python']);
  assert.deepEqual(found.skills, ['kubernetes']);
});

test('with no requirements section everything lands in skills', () => {
  // 57% of real postings have no header the segmenter recognises. skillsScore
  // promotes `skills` when required is empty, so this must stay non-empty.
  const gaz = buildGazetteer(CORPUS, { minJobs: 3 });
  const found = extractSkills('We use Python and Kubernetes here.', gaz);
  assert.deepEqual(found.required_skills, []);
  assert.deepEqual(found.skills.sort(), ['kubernetes', 'python']);
});

test('short and ambiguous terms must match their real casing', () => {
  const gaz = buildGazetteer(
    [labelled(['Go']), labelled(['Go']), labelled(['Go'])],
    { minJobs: 3 }
  );
  // Prose: "go" here is a verb, and counting it would put Go on most postings.
  assert.deepEqual(extractSkills('You will go to conferences.', gaz).skills, []);
  assert.deepEqual(extractSkills('Backend services written in Go.', gaz).skills, ['go']);
});

test('skill boundaries survive punctuation in the term', () => {
  const gaz = buildGazetteer(
    [labelled(['C++', 'Node.js']), labelled(['C++', 'Node.js']), labelled(['C++', 'Node.js'])],
    { minJobs: 3 }
  );
  const found = extractSkills('Services in C++ and Node.js.', gaz);
  assert.deepEqual(found.skills.sort(), ['c++', 'node.js']);
  // The "c" of "c++" must not be found on its own inside another word.
  assert.deepEqual(extractSkills('We care about clean code.', gaz).skills, []);
});

test('a posting with no text or an empty vocabulary yields nothing', () => {
  const gaz = buildGazetteer(CORPUS, { minJobs: 3 });
  assert.deepEqual(extractSkills('', gaz), { skills: [], required_skills: [] });
  assert.deepEqual(extractSkills('Python', null), { skills: [], required_skills: [] });
  assert.deepEqual(buildGazetteer([], {}).patterns, []);
});
