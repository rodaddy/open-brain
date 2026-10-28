-- Add structured contact fields to relationships table
-- Supports upsert_person tool (issue #9)

ALTER TABLE relationships ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE relationships ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE relationships ADD COLUMN IF NOT EXISTS relationship_type TEXT;
ALTER TABLE relationships ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
