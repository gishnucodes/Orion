/**
 * Skill canonicalisation for v2 scoring.
 *
 * ALIASES collapse spellings of the same thing to one canonical key ("GCP" and
 * "Google Cloud Platform"). RELATED groups are different-but-transferable skills
 * that earn partial credit in the skills component ("TypeScript" when the CV has
 * "JavaScript"). Everything is stored in normKey form, so plurals and
 * punctuation are already folded.
 *
 * Extend freely — an alias or group added here takes effect on the next score run.
 */
import { normKey } from './text.mjs';

const ALIAS_GROUPS = {
  'gcp': ['google cloud', 'google cloud platform', 'gcp'],
  'aws': ['aws', 'amazon web services'],
  'azure': ['azure', 'microsoft azure', 'ms azure'],
  'kubernetes': ['kubernetes', 'k8s', 'gke', 'eks', 'aks'],
  'javascript': ['javascript', 'js', 'ecmascript'],
  'typescript': ['typescript', 'ts'],
  'node.js': ['node.js', 'nodejs', 'node js', 'node'],
  'react': ['react', 'react.js', 'reactjs', 'react js'],
  'next.js': ['next.js', 'nextjs'],
  'python': ['python', 'python3', 'python 3'],
  'golang': ['go', 'golang'],
  'c++': ['c++', 'cpp'],
  'c#': ['c#', 'csharp'],
  'postgresql': ['postgresql', 'postgres', 'psql'],
  'mysql': ['mysql'],
  'sql': ['sql'],
  'mongodb': ['mongodb', 'mongo'],
  'neo4j': ['neo4j', 'neo4j graph database'],
  'elasticsearch': ['elasticsearch', 'elastic search', 'opensearch'],
  'kafka': ['kafka', 'apache kafka'],
  'spark': ['spark', 'apache spark', 'pyspark'],
  'pulsar': ['pulsar', 'apache pulsar'],
  'airflow': ['airflow', 'apache airflow'],
  'docker': ['docker', 'containers', 'containerization'],
  'ci/cd': ['ci/cd', 'ci cd', 'cicd', 'continuous integration', 'continuous delivery', 'continuous deployment'],
  'terraform': ['terraform', 'infrastructure as code', 'iac'],
  'llm': ['llm', 'llms', 'large language model', 'large language models', 'foundation model', 'foundation models'],
  'genai': ['generative ai', 'genai', 'gen ai'],
  'rag': ['rag', 'retrieval augmented generation', 'retrieval-augmented generation'],
  'ai agents': ['ai agents', 'agents', 'agentic', 'agentic ai', 'agentic systems', 'autonomous agents', 'multi-agent', 'multi agent'],
  'mcp': ['mcp', 'model context protocol'],
  'machine learning': ['machine learning', 'ml'],
  'deep learning': ['deep learning', 'dl'],
  'artificial intelligence': ['artificial intelligence', 'ai'],
  'nlp': ['nlp', 'natural language processing'],
  'computer vision': ['computer vision', 'cv', 'image processing'],
  'reinforcement learning': ['reinforcement learning', 'rl'],
  'pytorch': ['pytorch', 'torch'],
  'tensorflow': ['tensorflow', 'tf'],
  'hugging face': ['hugging face', 'huggingface', 'transformers'],
  'langchain': ['langchain', 'lang chain'],
  'langgraph': ['langgraph', 'lang graph'],
  'openai': ['openai', 'openai api', 'gpt', 'gpt-4', 'gpt 4', 'chatgpt'],
  'prompt engineering': ['prompt engineering', 'prompting', 'prompt design'],
  'fine-tuning': ['fine-tuning', 'fine tuning', 'finetuning', 'lora', 'peft'],
  'vector databases': ['vector database', 'vector databases', 'vector db', 'pinecone', 'weaviate', 'pgvector', 'milvus', 'qdrant', 'chroma'],
  'embeddings': ['embeddings', 'embedding', 'vector embeddings'],
  'mlops': ['mlops', 'ml ops', 'llmops'],
  'graphql': ['graphql'],
  'rest': ['rest', 'rest api', 'rest apis', 'restful', 'restful api'],
  'grpc': ['grpc'],
  'microservices': ['microservices', 'micro services', 'microservice architecture'],
  'distributed systems': ['distributed systems', 'distributed computing'],
  'temporal': ['temporal', 'temporal.io'],
  'spring boot': ['spring boot', 'spring'],
  'openshift': ['openshift', 'red hat openshift'],
  'gitlab': ['gitlab', 'gitlab ci'],
  'github actions': ['github actions'],
  'grafana': ['grafana'],
  'prometheus': ['prometheus'],
  'observability': ['observability', 'monitoring'],
  'bigquery': ['bigquery', 'big query'],
  'databricks': ['databricks'],
  'snowflake': ['snowflake'],
  'speech recognition': ['speech recognition', 'asr', 'speech to text', 'speech-to-text', 'stt'],
  'text to speech': ['text to speech', 'text-to-speech', 'tts'],
  'voice ai': ['voice ai', 'conversational ai', 'voice agents', 'realtime voice'],
  'livekit': ['livekit', 'live kit'],
  'webrtc': ['webrtc'],
  'linux': ['linux', 'unix'],
  'data pipelines': ['data pipelines', 'data pipeline', 'etl', 'elt'],
  'knowledge graph': ['knowledge graph', 'knowledge graphs', 'graph database', 'graph databases']
};

const RELATED_GROUPS = [
  ['gcp', 'aws', 'azure'],
  ['javascript', 'typescript', 'node.js'],
  ['react', 'next.js', 'vue', 'angular', 'svelte'],
  ['python', 'golang', 'java', 'c++', 'rust', 'scala', 'kotlin', 'c#'],
  ['java', 'kotlin', 'scala'],
  ['sql', 'postgresql', 'mysql', 'oracle', 'sqlite', 'sql server'],
  ['mongodb', 'dynamodb', 'cassandra', 'redis', 'couchbase'],
  ['neo4j', 'knowledge graph'],
  ['kafka', 'pulsar', 'rabbitmq', 'kinesis', 'pub/sub'],
  ['spark', 'databricks', 'flink', 'beam', 'dask'],
  ['bigquery', 'snowflake', 'redshift', 'databricks'],
  ['docker', 'kubernetes', 'openshift'],
  ['terraform', 'pulumi', 'cloudformation', 'ansible'],
  ['gitlab', 'github actions', 'jenkins', 'ci/cd', 'circleci'],
  ['pytorch', 'tensorflow', 'jax', 'keras'],
  ['langchain', 'langgraph', 'llamaindex', 'mastra', 'crewai', 'autogen', 'dspy'],
  ['llm', 'genai', 'openai', 'anthropic', 'claude', 'gemini', 'llama', 'mistral'],
  ['rag', 'vector databases', 'embeddings', 'semantic search'],
  ['ai agents', 'mcp', 'langgraph', 'mastra'],
  ['temporal', 'airflow', 'prefect', 'dagster', 'argo workflows'],
  ['grafana', 'prometheus', 'datadog', 'observability', 'opentelemetry'],
  ['graphql', 'rest', 'grpc'],
  ['voice ai', 'livekit', 'webrtc', 'speech recognition', 'text to speech'],
  ['machine learning', 'deep learning', 'artificial intelligence'],
  ['django', 'flask', 'fastapi'],
  ['spring boot', 'django', 'fastapi', 'express']
];

/**
 * Terms too generic to be a keyword signal on their own. They still flow into
 * semantic matching; they are only kept out of the skills and keyword ratios.
 */
export const GENERIC_TERMS = new Set([
  'api', 'software', 'engineering', 'development', 'technology', 'communication',
  'collaboration', 'problem solving', 'leadership', 'teamwork', 'english', 'documentation',
  'cloud', 'data', 'code', 'coding', 'programming', 'computer science', 'excel', 'microsoft office',
  'google workspace', 'slack', 'jira', 'confluence', 'agile', 'scrum', 'written communication',
  'verbal communication', 'stakeholder management', 'project management', 'json', 'git',
  'equity', 'discovery', 'customer experience', 'customer success', 'sales', 'marketing', 'strategy',
  'operations', 'business', 'product', 'research', 'design', 'security', 'saas', 'b2b', 'enterprise',
  'hybrid', 'remote', 'onsite', 'in-office', 'startup'
].map(normKey));

const aliasToCanon = new Map();
for (const [canon, aliases] of Object.entries(ALIAS_GROUPS)) {
  const c = normKey(canon);
  aliasToCanon.set(c, c);
  for (const a of aliases) aliasToCanon.set(normKey(a), c);
}

/**
 * Aliases that are ordinary English words. They canonicalise an *extracted*
 * skill ("Go" -> golang) but are never scanned for in free text, where "go to
 * market" or "the rest of the team" would otherwise count as keywords.
 */
export const AMBIGUOUS_TERMS = new Set([
  'go', 'node', 'ts', 'tf', 'cv', 'rl', 'dl', 'rest', 'spring', 'torch', 'agents', 'containers',
  'monitoring', 'transformers', 'gpt', 'iac', 'stt', 'tts', 'asr', 'unix', 'chroma', 'js', 'beam',
  'express', 'flask', 'swift', 'dart', 'r', 'c',
  // Model/vendor names mostly appear as the employer's own product ("Claude" in
  // every Anthropic posting), not as a requirement; count them only when extracted.
  'claude', 'gemini', 'llama', 'mistral', 'anthropic'
].map(normKey));

// Every unambiguous ontology surface form, for building the keyword vocabulary.
export const ONTOLOGY_TERMS = [...new Set([
  ...aliasToCanon.keys(),
  ...RELATED_GROUPS.flat().map(normKey)
])].filter((t) => !AMBIGUOUS_TERMS.has(t));

export function canon(term) {
  const key = normKey(term);
  return aliasToCanon.get(key) ?? key;
}

const relatedMap = new Map();
for (const group of RELATED_GROUPS) {
  const keys = group.map(canon);
  for (const k of keys) {
    if (!relatedMap.has(k)) relatedMap.set(k, new Set());
    for (const other of keys) if (other !== k) relatedMap.get(k).add(other);
  }
}

export function relatedTo(canonKey) {
  return relatedMap.get(canonKey) ?? new Set();
}

export function isGeneric(canonKey) {
  return GENERIC_TERMS.has(canonKey) || canonKey.length < 2 || /^\d+$/.test(canonKey);
}
