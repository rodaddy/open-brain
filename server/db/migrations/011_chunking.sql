-- Migration: Chunking support for long thoughts
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES thoughts(id) ON DELETE CASCADE;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS chunk_index INTEGER;
CREATE INDEX IF NOT EXISTS idx_thoughts_parent_id ON thoughts(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_thoughts_non_chunk ON thoughts(created_at DESC) WHERE parent_id IS NULL AND archived_at IS NULL;
