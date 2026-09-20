-- 0023_opening_memory_privacy_epoch.sql
-- M02: workspace privacy epoch + content-free exclusion journal (restore exclusion boundary for Q03)
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS privacy_epoch integer NOT NULL DEFAULT 0
  CHECK (privacy_epoch >= 0);

CREATE TABLE IF NOT EXISTS opening_privacy_exclusions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  memory_id uuid NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, source_id)
);
CREATE INDEX IF NOT EXISTS opening_privacy_exclusions_workspace_idx
  ON opening_privacy_exclusions (workspace_id);
