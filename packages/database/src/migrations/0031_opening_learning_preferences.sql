ALTER TABLE workspace_preferences ALTER COLUMN default_entry DROP NOT NULL;
ALTER TABLE workspace_preferences
  ADD COLUMN assessment_enabled boolean NULL,
  ADD COLUMN retest_suggestions_enabled boolean NULL,
  ADD COLUMN automatic_reminders_enabled boolean NULL;

ALTER TABLE courses
  ADD COLUMN assessment_enabled boolean NULL,
  ADD COLUMN retest_suggestions_enabled boolean NULL,
  ADD COLUMN automatic_reminders_enabled boolean NULL;

-- NULL means no explicit account choice (disabled) or no course override (inherit).
-- Existing rows retain their explicit default entry without acquiring implicit opt-in.
