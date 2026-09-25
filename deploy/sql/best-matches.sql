-- Orion: today's best set of jobs to apply to (BigQuery, table orion.jobs).
--
-- Mirrors what the email digest selects, plus de-duplication and a per-company
-- cap so one employer's near-identical postings do not crowd out the list.
-- Knobs: min_score (0-100, 65 = config threshold), max_age_days, per_company, top_n.
DECLARE min_score    FLOAT64 DEFAULT 65;
DECLARE max_age_days INT64   DEFAULT 7;
DECLARE per_company  INT64   DEFAULT 2;
DECLARE top_n        INT64   DEFAULT 25;

WITH eligible AS (
  SELECT *
  FROM orion.jobs
  WHERE score >= min_score
    AND gate IS NULL                                   -- title/location gates passed
    AND has_description                                -- scored on the real posting text
    AND IF(skills_score IS NULL, 0, 1) + IF(keywords_score IS NULL, 0, 1)
      + IF(semantic_score IS NULL, 0, 1) >= 2           -- same min_components rule as the digest
    AND last_seen >= DATE_SUB(CURRENT_DATE(), INTERVAL max_age_days DAY)  -- still listed
),
deduped AS (
  -- The same role posted under several URLs (Roblox, Databricks) counts once.
  SELECT *
  FROM eligible
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY LOWER(company), REGEXP_REPLACE(LOWER(title), r'[^a-z0-9]+', ' ')
    ORDER BY score DESC, last_seen DESC, job_id DESC
  ) = 1
),
capped AS (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY LOWER(company) ORDER BY score DESC) AS company_rank
  FROM deduped
  QUALIFY company_rank <= per_company
)
SELECT
  ROUND(score / 10, 1)                  AS score_10,
  company,
  title,
  location,
  seniority_level,
  score_confidence,                                    -- partial = no Gemini extraction yet
  ROUND(skills_score, 2)                AS skills,
  ROUND(keywords_score, 2)              AS keywords,
  ROUND(semantic_score, 2)              AS semantic,
  ROUND(entity_delta, 2)                AS delta,
  ARRAY_TO_STRING(ARRAY(SELECT k FROM UNNEST(missing_keywords) k LIMIT 6), ', ') AS add_to_resume,
  ARRAY_TO_STRING(alias_keywords, ', ') AS reword_in_resume,
  first_seen,
  url
FROM capped
-- LIMIT only takes literals, so the top_n cut is a window rank.
QUALIFY ROW_NUMBER() OVER (
  ORDER BY score DESC,
    score_confidence = 'full' DESC,                    -- fully scored first on ties
    first_seen DESC                                    -- then the freshest posting
) <= top_n
ORDER BY score DESC, score_confidence = 'full' DESC, first_seen DESC;
