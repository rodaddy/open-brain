/** Row shapes read from Open Brain tables by the Obsidian vault sync. */

export interface PersonRow {
  id: string;
  person_name: string;
  context: string | null;
  warmth: number | null;
  last_contact: string | null;
  notes: string | null;
  tags: string[];
  relationship_type: string | null;
  email: string | null;
  phone: string | null;
  metadata: Record<string, unknown> | null;
  created_by: string;
  created_at: string;
  updated_at: string | null;
  namespace: string;
}

export interface DecisionRow {
  id: string;
  title: string;
  rationale: string;
  alternatives: unknown[];
  tags: string[];
  context: string | null;
  created_by: string;
  created_at: string;
  updated_at: string | null;
  namespace: string;
}

export interface ThoughtRow {
  id: string;
  content: string;
  tags: string[];
  source: string;
  created_by: string;
  created_at: string;
  updated_at: string | null;
  namespace: string;
}

export interface SessionRow {
  id: string;
  project: string | null;
  summary: string;
  tags: string[];
  blockers: string[];
  next_steps: string[];
  key_decisions: string[];
  created_by: string;
  created_at: string;
  updated_at: string | null;
  namespace: string;
}

export interface SyncStats {
  written: number;
  skipped: number;
  orphansRemoved: number;
  projectCount: number;
}
