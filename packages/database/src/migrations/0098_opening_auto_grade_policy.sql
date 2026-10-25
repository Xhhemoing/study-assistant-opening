-- NULL preserves the existing first-submission default for legacy preferences.
ALTER TABLE workspace_preferences ADD COLUMN auto_grade_on_save boolean;
-- Durable automatic admission origin/time, independent of paid job retention.
-- Existing rows stay NULL: their automatic/manual origin is unknown.
ALTER TABLE opening_learning_observations ADD COLUMN auto_grade_enqueued_at timestamptz;
CREATE INDEX opening_observations_auto_grade_day_idx
  ON opening_learning_observations(workspace_id, auto_grade_enqueued_at)
  WHERE auto_grade_enqueued_at IS NOT NULL;
-- Rollback: stop automatic admission and deploy a compatible reader first.
-- Retain these columns/index, user OFF choices, admission history and paid ledgers.
-- Never drop the preference column to roll back: that would turn explicit OFF ON.
