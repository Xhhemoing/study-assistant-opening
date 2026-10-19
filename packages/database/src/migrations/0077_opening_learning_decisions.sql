-- Decisions are immutable provenance receipts, never learning/mastery facts.
-- Rollback: deploy prior application, retain this additive table and receipts.
CREATE TABLE opening_learning_decisions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  layer text NOT NULL CHECK (layer IN ('plan','session','activity')),
  target_id uuid NOT NULL,
  parent_decision_id uuid REFERENCES opening_learning_decisions(id),
  client_key text NOT NULL,
  receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workspace_id,owner_user_id,client_key),
  CHECK (layer <> 'plan' OR parent_decision_id IS NULL)
);
CREATE INDEX opening_learning_decisions_target ON opening_learning_decisions(workspace_id,owner_user_id,layer,target_id,created_at DESC);
