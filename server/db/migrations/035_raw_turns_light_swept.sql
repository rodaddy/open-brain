-- Migration 035: ob_raw_turns.light_swept_at -- Light's idempotency marker (Issue #390)
--
-- Spec: docs/dream-design.md, Stage 1 LIGHT.
--
-- WHY A SECOND MARKER, when distilled_at already exists. They mark different
-- work and must not be conflated:
--
--   distilled_at    -- has REM/the distiller turned this turn into candidates?
--                      NULL is the distillation work queue
--                      (032_raw_turns.sql:137-138).
--   light_swept_at  -- has Light counted this turn into content_occurrences?
--
-- Light is always-on and model-free; distillation is idle-triggered and
-- model-bearing. They run at different cadences over the same rows, so one
-- marker cannot serve both: reusing distilled_at would either make Light claim
-- turns the distiller has not seen, or make the distiller skip turns Light
-- already counted. Each stage owns its own progress.
--
-- WHY IT MATTERS FOR CORRECTNESS, not just efficiency. The maintenance queue is
-- at-least-once, so a Light job WILL be re-delivered. Without a marker, a
-- replay re-counts the same turns and inflates occurrence_count and
-- session_count -- silently corrupting the corroboration signal that promotion
-- (#394) and supersession (#396) read. An inflated count does not look like a
-- bug; it looks like evidence. That is the failure mode this column prevents.
--
-- Partial index only on unswept rows: that is the only set the sweep ever
-- selects, and it shrinks toward empty as Light catches up, unlike a full index
-- that would grow forever with the corpus.

ALTER TABLE ob_raw_turns
  ADD COLUMN IF NOT EXISTS light_swept_at TIMESTAMPTZ;

COMMENT ON COLUMN ob_raw_turns.light_swept_at IS
  'When DREAM Light counted this turn into content_occurrences. NULL is the '
  'Light work queue. Distinct from distilled_at, which tracks distillation: '
  'the two stages run at different cadences and each owns its own marker. '
  'Required for idempotency -- the queue is at-least-once, and a replayed '
  'sweep without this would silently inflate the corroboration counts.';

CREATE INDEX IF NOT EXISTS idx_ob_raw_turns_light_unswept
  ON ob_raw_turns (occurred_at)
  WHERE light_swept_at IS NULL;
