-- Temporary tutoring stores only call identity and material lineage, never its body.
CREATE TABLE opening_ephemeral_provenance (
  id uuid PRIMARY KEY REFERENCES opening_budget_reservations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL,
  privacy_epoch bigint NOT NULL CHECK (privacy_epoch >= 0),
  context_source_refs jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (context_source_refs IS NULL OR jsonb_typeof(context_source_refs) = 'array')
);
CREATE INDEX opening_ephemeral_provenance_workspace_idx ON opening_ephemeral_provenance(workspace_id);

-- Independent of editable blocks/revisions and of temporary call-ledger retention.
CREATE TABLE opening_note_provenance (
  document_id uuid PRIMARY KEY REFERENCES library_documents(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  context_source_refs jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (context_source_refs IS NULL OR jsonb_typeof(context_source_refs) = 'array')
);
CREATE INDEX opening_note_provenance_workspace_idx ON opening_note_provenance(workspace_id);
