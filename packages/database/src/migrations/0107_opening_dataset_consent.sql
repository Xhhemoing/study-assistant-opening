-- Consent is intentionally outside backup/restore: restoring facts cannot restore permission.
CREATE TABLE opening_dataset_consents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  policy_version text NOT NULL CHECK (policy_version = 'opening-dataset-v1'),
  privacy_epoch integer NOT NULL CHECK (privacy_epoch >= 0),
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > granted_at)
);
CREATE INDEX opening_dataset_consents_scope_idx ON opening_dataset_consents(workspace_id, owner_user_id, granted_at DESC);
