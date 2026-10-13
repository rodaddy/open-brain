-- Store the hybrid-only English document vector for session events. This is
-- the same expression the hybrid lexical arm previously computed per row;
-- keyword mode and the canonical resource search_vector columns are unchanged.
--
-- Rollback (after deploying application code that no longer reads the column):
--   DROP INDEX idx_ob_session_events_hybrid_fts;
--   ALTER TABLE ob_session_events DROP COLUMN hybrid_search_vector;

ALTER TABLE ob_session_events ADD COLUMN hybrid_search_vector tsvector
  GENERATED ALWAYS AS (hybrid_search_tsvector(
    'english'::regconfig,
    content,
    false
  )) STORED;

CREATE INDEX idx_ob_session_events_hybrid_fts
  ON ob_session_events USING GIN(hybrid_search_vector);
