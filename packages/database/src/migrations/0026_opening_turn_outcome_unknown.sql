-- 0026_opening_turn_outcome_unknown.sql
-- Preserve provider-uncertain assistant outcomes as distinct from definitive failures.

ALTER TABLE opening_turns
  DROP CONSTRAINT IF EXISTS opening_turns_status_check;

ALTER TABLE opening_turns
  ADD CONSTRAINT opening_turns_status_check
  CHECK (status IN ('pending', 'complete', 'failed', 'outcome_unknown'));
