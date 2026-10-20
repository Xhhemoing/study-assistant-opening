-- Immutable pre-answer shadow forecasts. Models cannot write learning facts.
-- Rollback: deploy previous code and retain this additive audit table.
CREATE TABLE opening_learning_shadow_predictions (
  attempt_id uuid PRIMARY KEY REFERENCES opening_learning_attempts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id uuid,
  requirement_key text,
  family_key text,
  input_cutoff timestamptz NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  state_version text NOT NULL,
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object')
);
CREATE INDEX opening_learning_shadow_predictions_owner_time ON opening_learning_shadow_predictions(workspace_id,owner_user_id,input_cutoff);
