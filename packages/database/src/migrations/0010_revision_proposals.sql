CREATE UNIQUE INDEX IF NOT EXISTS library_documents_workspace_id_uidx
  ON library_documents(workspace_id, id);

CREATE TABLE revision_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES library_documents(id) ON DELETE CASCADE,
  base_revision_number integer NOT NULL CHECK (base_revision_number > 0),
  base_title text NOT NULL,
  base_blocks jsonb NOT NULL,
  proposed_title text NULL,
  proposed_blocks jsonb NOT NULL,
  diff jsonb NOT NULL,
  source jsonb NOT NULL,
  provenance jsonb NOT NULL,
  support_state text NOT NULL CHECK (support_state IN ('supported','partial','insufficient','conflicting','inference')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','conflicted')),
  review_action text NULL CHECK (review_action IN ('accept','partial_accept','reject','preserve_both')),
  reviewer_user_id uuid NULL,
  reviewed_at timestamptz NULL,
  resulting_revision_number integer NULL CHECK (resulting_revision_number IS NULL OR resulting_revision_number > 0),
  current_conflict jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, document_id) REFERENCES library_documents(workspace_id, id) ON DELETE CASCADE,
  CHECK ((status = 'pending' AND reviewed_at IS NULL AND review_action IS NULL)
    OR (status <> 'pending' AND reviewed_at IS NOT NULL AND review_action IS NOT NULL)),
  CHECK ((status = 'conflicted') = (current_conflict IS NOT NULL))
);

CREATE INDEX revision_proposals_document_status_idx
  ON revision_proposals(workspace_id, document_id, status, created_at DESC);
CREATE INDEX revision_proposals_workspace_status_idx
  ON revision_proposals(workspace_id, status, created_at DESC);
CREATE UNIQUE INDEX revision_proposals_document_revision_uidx
  ON revision_proposals(workspace_id, document_id, resulting_revision_number)
  WHERE resulting_revision_number IS NOT NULL;

CREATE OR REPLACE FUNCTION revision_proposals_reject_snapshot_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.document_id IS DISTINCT FROM NEW.document_id
    OR OLD.base_revision_number IS DISTINCT FROM NEW.base_revision_number
    OR OLD.base_title IS DISTINCT FROM NEW.base_title
    OR OLD.base_blocks IS DISTINCT FROM NEW.base_blocks
    OR OLD.proposed_title IS DISTINCT FROM NEW.proposed_title
    OR OLD.proposed_blocks IS DISTINCT FROM NEW.proposed_blocks
    OR OLD.diff IS DISTINCT FROM NEW.diff
    OR OLD.source IS DISTINCT FROM NEW.source
    OR OLD.provenance IS DISTINCT FROM NEW.provenance
    OR OLD.support_state IS DISTINCT FROM NEW.support_state
  THEN
    RAISE EXCEPTION 'revision proposal snapshot is immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS revision_proposals_snapshot_guard ON revision_proposals;
CREATE TRIGGER revision_proposals_snapshot_guard
  BEFORE UPDATE ON revision_proposals
  FOR EACH ROW EXECUTE FUNCTION revision_proposals_reject_snapshot_mutation();
