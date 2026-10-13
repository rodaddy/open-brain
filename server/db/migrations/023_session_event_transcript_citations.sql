-- Migration 023: Host-neutral transcript citations for session events (#288)
-- A journal event can retain a durable conversation reference and an optional
-- captured exchange. The reference is deliberately host-neutral so callers do
-- not persist workstation-specific /Volumes or /mnt locations.

ALTER TABLE ob_session_events
  ADD COLUMN IF NOT EXISTS transcript_ref TEXT,
  ADD COLUMN IF NOT EXISTS transcript TEXT,
  ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ob_session_events_transcript_ref_host_neutral'
      AND conrelid = 'ob_session_events'::regclass
  ) THEN
    ALTER TABLE ob_session_events
      ADD CONSTRAINT ob_session_events_transcript_ref_host_neutral
      CHECK (
        transcript_ref IS NULL
        OR transcript_ref ~ '^collab/[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ob_session_events_transcript_citation_ref_required'
      AND conrelid = 'ob_session_events'::regclass
  ) THEN
    ALTER TABLE ob_session_events
      ADD CONSTRAINT ob_session_events_transcript_citation_ref_required
      CHECK (
        (transcript IS NULL AND occurred_at IS NULL)
        OR transcript_ref IS NOT NULL
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_session_events_transcript_ref
  ON ob_session_events (lane_id, transcript_ref, created_at, id)
  WHERE transcript_ref IS NOT NULL;
