-- Add extracted_metadata JSONB to thoughts and decisions
-- Rehash existing content with lowercase normalization

-- New columns for LLM-extracted metadata
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS extracted_metadata JSONB;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS extracted_metadata JSONB;

-- Rehash existing rows: old hash was trim+collapse-whitespace, new adds lowercase
-- Using convert_to() for proper text-to-bytea conversion

-- thoughts: hash input is content
UPDATE thoughts
SET content_hash = encode(sha256(convert_to(regexp_replace(trim(lower(content)), '\s+', ' ', 'g'), 'UTF8')), 'hex')
WHERE content_hash IS NOT NULL;

-- decisions: hash input is title || '\n' || rationale
UPDATE decisions
SET content_hash = encode(sha256(convert_to(regexp_replace(trim(lower(title || E'\n' || rationale)), '\s+', ' ', 'g'), 'UTF8')), 'hex')
WHERE content_hash IS NOT NULL;

-- sessions: hash includes timestamp (summary + '|' + ISO timestamp), cannot rehash
-- relationships: rehash based on person_name + context
UPDATE relationships
SET content_hash = encode(sha256(convert_to(regexp_replace(trim(lower(
  person_name || COALESCE(E'\n' || context, '') || COALESCE(E'\n' || notes, '')
)), '\s+', ' ', 'g'), 'UTF8')), 'hex')
WHERE content_hash IS NOT NULL;
