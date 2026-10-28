-- Hybrid-only lexical normalization. The canonical search_vector columns and
-- keyword-mode behavior remain unchanged.
--
-- Rollback strategy (maintenance window; each column drop takes a table lock):
--   DROP INDEX IF EXISTS idx_{table}_hybrid_fts;
--   ALTER TABLE {table} DROP COLUMN IF EXISTS hybrid_search_vector;
--   DROP FUNCTION IF EXISTS hybrid_search_tsvector(regconfig, text, boolean);

CREATE OR REPLACE FUNCTION hybrid_search_tsvector(
  config regconfig,
  source_text text,
  canonicalize_query_numbers boolean DEFAULT false
)
RETURNS tsvector
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  compound_text text;
  combined_vector tsvector;
  combined_lexemes text[];
  alias_text text;
  digit integer;
  digit_words constant text[] := ARRAY[
    'zero', 'one', 'two', 'three', 'four',
    'five', 'six', 'seven', 'eight', 'nine'
  ];
  result tsvector;
BEGIN
  SELECT string_agg(component, ' ')
  INTO compound_text
  FROM regexp_split_to_table(COALESCE(source_text, ''), '[[:space:]]+') AS tokens(token)
  CROSS JOIN LATERAL regexp_split_to_table(tokens.token, '/') AS components(component)
  WHERE tokens.token LIKE '%/%' AND components.component <> '';

  combined_vector := to_tsvector(config, COALESCE(source_text, '')) ||
    to_tsvector(config, COALESCE(compound_text, ''));
  IF config = 'english'::regconfig THEN
    combined_lexemes := tsvector_to_array(combined_vector);
    SELECT string_agg(digit_words[parsed_digit + 1], ' ')
    INTO alias_text
    FROM (
      SELECT DISTINCT lexeme::integer AS parsed_digit
      FROM unnest(combined_lexemes) AS parsed(lexeme)
      WHERE lexeme ~ '^[0-9]$'
    ) AS singleton_digits
    WHERE NOT digit_words[parsed_digit + 1] = ANY(combined_lexemes);
    result := combined_vector || to_tsvector(config, COALESCE(alias_text, ''));
    IF canonicalize_query_numbers THEN
      FOR digit IN 0..9 LOOP
        IF digit_words[digit + 1] = ANY(tsvector_to_array(result)) THEN
          result := ts_delete(result, digit::text);
        END IF;
      END LOOP;
    END IF;
  ELSE
    result := combined_vector;
  END IF;
  RETURN result;
END;
$$;

ALTER TABLE thoughts ADD COLUMN hybrid_search_vector tsvector
  GENERATED ALWAYS AS (hybrid_search_tsvector(
    'english'::regconfig,
    COALESCE(content, '') || ' ' ||
      COALESCE(immutable_array_to_string(tags, ' '), ''),
    false
  )) STORED;
CREATE INDEX idx_thoughts_hybrid_fts
  ON thoughts USING GIN(hybrid_search_vector) WHERE archived_at IS NULL;

ALTER TABLE decisions ADD COLUMN hybrid_search_vector tsvector
  GENERATED ALWAYS AS (hybrid_search_tsvector(
    'english'::regconfig,
    COALESCE(title, '') || ' ' || COALESCE(rationale, '') || ' ' ||
      COALESCE(context, '') || ' ' ||
      COALESCE(immutable_array_to_string(tags, ' '), ''),
    false
  )) STORED;
CREATE INDEX idx_decisions_hybrid_fts
  ON decisions USING GIN(hybrid_search_vector) WHERE archived_at IS NULL;

ALTER TABLE relationships ADD COLUMN hybrid_search_vector tsvector
  GENERATED ALWAYS AS (hybrid_search_tsvector(
    'english'::regconfig,
    COALESCE(person_name, '') || ' ' || COALESCE(context, '') || ' ' ||
      COALESCE(immutable_array_to_string(tags, ' '), ''),
    false
  )) STORED;
CREATE INDEX idx_relationships_hybrid_fts
  ON relationships USING GIN(hybrid_search_vector) WHERE archived_at IS NULL;

ALTER TABLE projects ADD COLUMN hybrid_search_vector tsvector
  GENERATED ALWAYS AS (hybrid_search_tsvector(
    'english'::regconfig,
    COALESCE(name, '') || ' ' || COALESCE(description, '') || ' ' ||
      COALESCE(immutable_array_to_string(tags, ' '), ''),
    false
  )) STORED;
CREATE INDEX idx_projects_hybrid_fts
  ON projects USING GIN(hybrid_search_vector) WHERE archived_at IS NULL;

ALTER TABLE sessions ADD COLUMN hybrid_search_vector tsvector
  GENERATED ALWAYS AS (hybrid_search_tsvector(
    'english'::regconfig,
    COALESCE(summary, '') || ' ' ||
      COALESCE(immutable_array_to_string(next_steps, ' '), '') || ' ' ||
      COALESCE(immutable_array_to_string(key_decisions, ' '), '') || ' ' ||
      COALESCE(immutable_array_to_string(tags, ' '), ''),
    false
  )) STORED;
CREATE INDEX idx_sessions_hybrid_fts
  ON sessions USING GIN(hybrid_search_vector) WHERE archived_at IS NULL;
