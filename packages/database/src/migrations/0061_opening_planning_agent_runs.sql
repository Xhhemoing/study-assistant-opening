-- Saved, bounded planning runs. No transcript/hidden reasoning is stored here.
CREATE TABLE opening_planning_agent_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_key text NOT NULL,
  input_hash text NOT NULL,
  privacy_epoch bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('running','completed','failed','unknown')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, client_key)
);
CREATE INDEX opening_planning_agent_runs_recent ON opening_planning_agent_runs(workspace_id, created_at DESC);

-- Store intent and explicit first-run completion in existing workspace preferences.
ALTER TABLE workspace_preferences ADD COLUMN opening_onboarding jsonb;
-- Initial tasks retain their real course/material context without accepting model-supplied ownership.
ALTER TABLE opening_tasks ADD COLUMN course_id uuid REFERENCES courses(id) ON DELETE SET NULL;
ALTER TABLE opening_tasks ADD COLUMN source_ids uuid[] NOT NULL DEFAULT '{}';

ALTER TABLE workspace_preferences ADD COLUMN guidance_settings jsonb;

-- Forget/privacy changes invalidate cached agent explanations as well as access.
CREATE FUNCTION opening_invalidate_agent_results_on_privacy_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.privacy_epoch IS DISTINCT FROM OLD.privacy_epoch THEN
    UPDATE opening_planning_agent_runs SET result=NULL,status='unknown',updated_at=now()
      WHERE workspace_id=NEW.id AND privacy_epoch<>NEW.privacy_epoch;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER opening_agent_result_privacy_fence AFTER UPDATE OF privacy_epoch ON workspaces
  FOR EACH ROW EXECUTE FUNCTION opening_invalidate_agent_results_on_privacy_change();
