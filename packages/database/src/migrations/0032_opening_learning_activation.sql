ALTER TABLE workspace_preferences
  ADD COLUMN retest_suggestions_enabled_at timestamptz NULL,
  ADD COLUMN automatic_reminders_enabled_at timestamptz NULL;

ALTER TABLE courses
  ADD COLUMN retest_suggestions_enabled_at timestamptz NULL,
  ADD COLUMN automatic_reminders_enabled_at timestamptz NULL;

-- Earlier releases used updated_at as the cutoff. Preserve that cutoff for
-- existing local permissions; migration alone must neither opt in nor replay.
UPDATE workspace_preferences SET
  retest_suggestions_enabled_at = CASE
    WHEN assessment_enabled IS TRUE AND retest_suggestions_enabled IS TRUE THEN updated_at END,
  automatic_reminders_enabled_at = CASE
    WHEN assessment_enabled IS TRUE AND automatic_reminders_enabled IS TRUE THEN updated_at END;
UPDATE courses SET
  retest_suggestions_enabled_at = CASE
    WHEN archived_at IS NULL AND assessment_enabled IS DISTINCT FROM false
      AND retest_suggestions_enabled IS DISTINCT FROM false THEN updated_at END,
  automatic_reminders_enabled_at = CASE
    WHEN archived_at IS NULL AND assessment_enabled IS DISTINCT FROM false
      AND automatic_reminders_enabled IS DISTINCT FROM false THEN updated_at END;

-- Each trigger reads only its own row. Effective activation is the later of
-- account and course activation, avoiding cross-row locks in archive updates.
CREATE FUNCTION track_workspace_learning_activation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  retest_was_enabled boolean := false;
  reminders_were_enabled boolean := false;
  activated_at timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'UPDATE' THEN
    retest_was_enabled := OLD.assessment_enabled IS TRUE AND OLD.retest_suggestions_enabled IS TRUE;
    reminders_were_enabled := OLD.assessment_enabled IS TRUE AND OLD.automatic_reminders_enabled IS TRUE;
  END IF;
  IF NEW.assessment_enabled IS TRUE AND NEW.retest_suggestions_enabled IS TRUE THEN
    NEW.retest_suggestions_enabled_at := CASE WHEN retest_was_enabled
      THEN OLD.retest_suggestions_enabled_at ELSE activated_at END;
  ELSE
    NEW.retest_suggestions_enabled_at := NULL;
  END IF;
  IF NEW.assessment_enabled IS TRUE AND NEW.automatic_reminders_enabled IS TRUE THEN
    NEW.automatic_reminders_enabled_at := CASE WHEN reminders_were_enabled
      THEN OLD.automatic_reminders_enabled_at ELSE activated_at END;
  ELSE
    NEW.automatic_reminders_enabled_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workspace_learning_activation
  BEFORE INSERT OR UPDATE ON workspace_preferences
  FOR EACH ROW EXECUTE FUNCTION track_workspace_learning_activation();

CREATE FUNCTION track_course_learning_activation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  retest_was_enabled boolean := false;
  reminders_were_enabled boolean := false;
  activated_at timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'UPDATE' THEN
    retest_was_enabled := OLD.archived_at IS NULL AND OLD.assessment_enabled IS DISTINCT FROM false
      AND OLD.retest_suggestions_enabled IS DISTINCT FROM false;
    reminders_were_enabled := OLD.archived_at IS NULL AND OLD.assessment_enabled IS DISTINCT FROM false
      AND OLD.automatic_reminders_enabled IS DISTINCT FROM false;
  END IF;
  IF NEW.archived_at IS NULL AND NEW.assessment_enabled IS DISTINCT FROM false
      AND NEW.retest_suggestions_enabled IS DISTINCT FROM false THEN
    NEW.retest_suggestions_enabled_at := CASE WHEN retest_was_enabled
      THEN OLD.retest_suggestions_enabled_at ELSE activated_at END;
  ELSE
    NEW.retest_suggestions_enabled_at := NULL;
  END IF;
  IF NEW.archived_at IS NULL AND NEW.assessment_enabled IS DISTINCT FROM false
      AND NEW.automatic_reminders_enabled IS DISTINCT FROM false THEN
    NEW.automatic_reminders_enabled_at := CASE WHEN reminders_were_enabled
      THEN OLD.automatic_reminders_enabled_at ELSE activated_at END;
  ELSE
    NEW.automatic_reminders_enabled_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER course_learning_activation
  BEFORE INSERT OR UPDATE ON courses
  FOR EACH ROW EXECUTE FUNCTION track_course_learning_activation();
