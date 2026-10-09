-- Additive only: retain existing preferences.
ALTER TABLE workspace_preferences ADD COLUMN planning_settings jsonb;
