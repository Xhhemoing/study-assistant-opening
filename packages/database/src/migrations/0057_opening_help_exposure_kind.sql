-- V2-13: teaching/answer help exposure kind + optional activity / item-version identity.
-- Nest into existing opening_help_exposures (no parallel mastery table).
-- Historical rows backfill kind='hint' only — never independent / correct / transfer.

ALTER TABLE opening_help_exposures
  ADD COLUMN kind TEXT,
  ADD COLUMN activity_id UUID NULL,
  ADD COLUMN item_version_id UUID NULL;

UPDATE opening_help_exposures SET kind = 'hint' WHERE kind IS NULL;

ALTER TABLE opening_help_exposures
  ALTER COLUMN kind SET NOT NULL,
  ADD CONSTRAINT opening_help_exposures_kind_check
    CHECK (kind IN ('instruction', 'hint', 'solution'));

ALTER TABLE opening_help_exposures
  ADD CONSTRAINT opening_help_exposures_activity_id_fkey
    FOREIGN KEY (activity_id) REFERENCES opening_teaching_activities(id) ON DELETE SET NULL,
  ADD CONSTRAINT opening_help_exposures_item_version_id_fkey
    FOREIGN KEY (item_version_id) REFERENCES opening_learning_item_versions(id) ON DELETE SET NULL;

CREATE INDEX opening_help_exposures_activity_idx
  ON opening_help_exposures (workspace_id, activity_id)
  WHERE activity_id IS NOT NULL;

CREATE INDEX opening_help_exposures_item_version_idx
  ON opening_help_exposures (workspace_id, item_version_id)
  WHERE item_version_id IS NOT NULL;
