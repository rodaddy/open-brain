-- Normalize the allowlisted pre-v22 local Development lane shape without
-- broadening session_start's public exact-scope contract. Unknown conflicts are
-- intentionally left unchanged for explicit operator review.
WITH candidates AS (
  SELECT
    id,
    substring(session_key FROM 5) AS canonical_project
  FROM ob_session_lanes
  WHERE session_key ~ '^dev:.+$'
    AND (
      agent = 'shared-session-finalizer'
      OR source = 'local-runtime'
    )
    AND agent IN ('shared-session-finalizer', 'shared')
    AND (source IS NULL OR source IN ('local-runtime', 'development'))
    AND thread_id IS NULL
    AND (
      metadata = 'null'::jsonb
      OR (
        jsonb_typeof(metadata) = 'object'
        AND (metadata->>'server_id' IS NULL OR metadata->>'server_id' = 'local')
      )
    )
    AND (
      channel_id IS NULL
      OR channel_id = substring(session_key FROM 5)
    )
    AND (
      project IS NULL
      OR lower(project) = lower(substring(session_key FROM 5))
    )
)
UPDATE ob_session_lanes AS lane
SET agent = 'shared',
    source = 'development',
    project = candidates.canonical_project,
    channel_id = candidates.canonical_project,
    metadata = CASE
      WHEN lane.metadata = 'null'::jsonb
        THEN jsonb_build_object('server_id', 'local')
      ELSE jsonb_set(lane.metadata, '{server_id}', '"local"'::jsonb, true)
    END
FROM candidates
WHERE lane.id = candidates.id;
