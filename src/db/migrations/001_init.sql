-- Open Brain schema: all 5 tables with halfvec(768) embeddings and HNSW indexes
-- CRITICAL: Use halfvec_cosine_ops for ALL HNSW indexes, NOT vector_cosine_ops

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Thoughts table
CREATE TABLE thoughts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content       TEXT NOT NULL,
  tags          TEXT[] DEFAULT '{}',
  source        TEXT DEFAULT 'manual',
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  embedding     halfvec(768),
  content_hash  TEXT,
  embedded_at   TIMESTAMPTZ,
  embedding_model TEXT
);

CREATE INDEX idx_thoughts_embedding ON thoughts
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 200);

CREATE UNIQUE INDEX idx_thoughts_content_hash ON thoughts (content_hash)
  WHERE content_hash IS NOT NULL;

-- Decisions table
CREATE TABLE decisions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  rationale     TEXT NOT NULL,
  alternatives  JSONB DEFAULT '[]',
  tags          TEXT[] DEFAULT '{}',
  context       TEXT,
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  embedding     halfvec(768),
  content_hash  TEXT,
  embedded_at   TIMESTAMPTZ,
  embedding_model TEXT
);

CREATE INDEX idx_decisions_embedding ON decisions
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 200);

CREATE UNIQUE INDEX idx_decisions_content_hash ON decisions (content_hash)
  WHERE content_hash IS NOT NULL;

-- Relationships table
CREATE TABLE relationships (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_name   TEXT NOT NULL,
  context       TEXT,
  warmth        INTEGER CHECK (warmth BETWEEN 1 AND 5),
  last_contact  DATE,
  notes         TEXT,
  tags          TEXT[] DEFAULT '{}',
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  embedding     halfvec(768),
  content_hash  TEXT,
  embedded_at   TIMESTAMPTZ,
  embedding_model TEXT
);

CREATE UNIQUE INDEX idx_relationships_person ON relationships (person_name);
CREATE INDEX idx_relationships_embedding ON relationships
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 200);

CREATE UNIQUE INDEX idx_relationships_content_hash ON relationships (content_hash)
  WHERE content_hash IS NOT NULL;

-- Projects table (DATA-02: secondary store alongside .planning/)
CREATE TABLE projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  status        TEXT DEFAULT 'active',
  description   TEXT,
  tags          TEXT[] DEFAULT '{}',
  metadata      JSONB DEFAULT '{}',
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  embedding     halfvec(768),
  content_hash  TEXT,
  embedded_at   TIMESTAMPTZ,
  embedding_model TEXT
);

CREATE UNIQUE INDEX idx_projects_name ON projects (name);
CREATE INDEX idx_projects_embedding ON projects
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 200);

CREATE UNIQUE INDEX idx_projects_content_hash ON projects (content_hash)
  WHERE content_hash IS NOT NULL;

-- Sessions table
CREATE TABLE sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project       TEXT,
  summary       TEXT NOT NULL,
  tags          TEXT[] DEFAULT '{}',
  blockers      TEXT[] DEFAULT '{}',
  next_steps    TEXT[] DEFAULT '{}',
  key_decisions TEXT[] DEFAULT '{}',
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  embedding     halfvec(768),
  content_hash  TEXT,
  embedded_at   TIMESTAMPTZ,
  embedding_model TEXT
);

CREATE INDEX idx_sessions_project ON sessions (project, created_at DESC);
CREATE INDEX idx_sessions_embedding ON sessions
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 200);

CREATE UNIQUE INDEX idx_sessions_content_hash ON sessions (content_hash)
  WHERE content_hash IS NOT NULL;

-- Migrations tracking table
CREATE TABLE _migrations (
  id            SERIAL PRIMARY KEY,
  filename      TEXT NOT NULL UNIQUE,
  applied_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Database-level safety for shared instance
ALTER DATABASE open_brain SET statement_timeout = '30s';
