-- Add descriptive tutor timing to the existing experience event stream.
ALTER TABLE opening_tutor_jobs ADD COLUMN timing_execution_id uuid;

ALTER TABLE opening_learning_experience_events
  ADD COLUMN execution_id uuid,
  ADD COLUMN observed_at timestamptz;

ALTER TABLE opening_learning_experience_events
  DROP CONSTRAINT opening_learning_experience_events_kind_check,
  DROP CONSTRAINT opening_learning_experience_events_duration_ms_check,
  DROP CONSTRAINT opening_learning_experience_events_check;

ALTER TABLE opening_learning_experience_events
  ADD CONSTRAINT opening_learning_experience_events_kind_check
    CHECK(kind IN ('first_text','next_step_shown','next_step_started','tutor_claimed','tutor_first_text','tutor_first_chunk')),
  ADD CONSTRAINT opening_learning_experience_events_duration_ms_check
    CHECK(duration_ms >= 0),
  ADD CONSTRAINT opening_learning_experience_events_shape_check CHECK (
    (kind='first_text' AND target_type='job' AND duration_ms IS NOT NULL AND duration_ms BETWEEN 1 AND 600000)
    OR (kind IN ('next_step_shown','next_step_started') AND target_type<>'job' AND duration_ms IS NULL)
    OR (kind IN ('tutor_claimed','tutor_first_text','tutor_first_chunk') AND target_type='job'
      AND execution_id IS NOT NULL AND observed_at IS NOT NULL)
  );

-- Roll back application code while retaining these descriptive events and nullable
-- columns. Do not drop timing rows or restore the narrower checks over existing data.
-- After stopping timing writers, the job-only link may be removed with:
-- ALTER TABLE opening_tutor_jobs DROP COLUMN timing_execution_id;
-- This does not delete business records, budget ledgers or recorded observations.
