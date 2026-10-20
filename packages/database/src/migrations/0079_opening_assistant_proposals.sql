-- Drafts and acceptance receipts only; learning facts remain in their existing owners.
CREATE TABLE opening_assistant_proposals (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  source_turn_id uuid NOT NULL REFERENCES opening_turns(id) ON DELETE CASCADE,
  client_key text NOT NULL,
  intent jsonb NOT NULL,
  prepared jsonb,
  context_source_refs jsonb NOT NULL,
  basis_version text NOT NULL,
  privacy_epoch integer NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','accepted','rejected')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  decision_client_key text,
  decision_action text CHECK (decision_action IN ('accept','reject')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opening_assistant_proposals_workspace_owner_key UNIQUE(workspace_id,owner_user_id,client_key)
);
CREATE INDEX opening_assistant_proposals_pending_idx ON opening_assistant_proposals(workspace_id,owner_user_id,status);
-- Application rollback: disable proposal entry points first; preserve this table and receipts.
