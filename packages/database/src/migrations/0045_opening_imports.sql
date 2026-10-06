-- C01 completion: durable import receipts and per-container cursors.
-- Receipts are not backed up and are synchronized with source ingestion.
CREATE TABLE opening_import_receipts (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES opening_connections(id) ON DELETE CASCADE,
  connection_version INTEGER NOT NULL CHECK (connection_version >= 0),
  identity_key TEXT NOT NULL CHECK (char_length(identity_key) BETWEEN 1 AND 1200),
  source_id UUID NOT NULL REFERENCES opening_sources(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, connection_id, identity_key)
);
CREATE INDEX opening_import_receipts_scope_idx
  ON opening_import_receipts (workspace_id, owner_user_id, connection_id, created_at);

CREATE TABLE opening_import_cursors (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES opening_connections(id) ON DELETE CASCADE,
  container TEXT NOT NULL CHECK (char_length(container) BETWEEN 1 AND 255),
  generation TEXT NOT NULL CHECK (char_length(generation) BETWEEN 1 AND 200),
  cursor JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, connection_id, container)
);

-- Rollback: DROP TABLE opening_import_cursors;
-- DROP TABLE opening_import_receipts;
