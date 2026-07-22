-- 0001_library.sql
-- Unified library foundation: workspace-scoped documents, blocks, append-only
-- revisions, typed relations, and typed properties.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS library_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  title text NOT NULL,
  lifecycle text NOT NULL
    CHECK (lifecycle IN (
      'scratch', 'candidate', 'confirmed', 'published', 'archived', 'discarded'
    )),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  current_revision_number integer NOT NULL DEFAULT 0 CHECK (current_revision_number >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS library_documents_workspace_idx
  ON library_documents (workspace_id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS library_blocks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES library_documents (id) ON DELETE CASCADE,
  type text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, position),
  UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS library_blocks_document_idx
  ON library_blocks (document_id, position);

CREATE TABLE IF NOT EXISTS library_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES library_documents (id) ON DELETE CASCADE,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  parent_revision_number integer NULL CHECK (
    parent_revision_number IS NULL OR parent_revision_number > 0
  ),
  title text NOT NULL,
  lifecycle text NOT NULL,
  reason text NOT NULL DEFAULT 'edit',
  blocks jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, revision_number)
);

CREATE INDEX IF NOT EXISTS library_revisions_document_idx
  ON library_revisions (document_id, revision_number);

-- Append-only: block UPDATE/DELETE on revisions is forbidden via trigger.
CREATE OR REPLACE FUNCTION library_reject_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'library_revisions is append-only'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS library_revisions_no_update ON library_revisions;
CREATE TRIGGER library_revisions_no_update
  BEFORE UPDATE ON library_revisions
  FOR EACH ROW
  EXECUTE FUNCTION library_reject_revision_mutation();

DROP TRIGGER IF EXISTS library_revisions_no_delete ON library_revisions;
CREATE TRIGGER library_revisions_no_delete
  BEFORE DELETE ON library_revisions
  FOR EACH ROW
  EXECUTE FUNCTION library_reject_revision_mutation();

CREATE TABLE IF NOT EXISTS library_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  from_type text NOT NULL CHECK (from_type IN ('document', 'block')),
  from_id uuid NOT NULL,
  to_type text NOT NULL CHECK (to_type IN ('document', 'block')),
  to_id uuid NOT NULL,
  relation_type text NOT NULL CHECK (relation_type IN (
    'references', 'supports', 'embeds', 'derived_from', 'related'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, from_type, from_id, to_type, to_id, relation_type)
);

CREATE INDEX IF NOT EXISTS library_relations_from_idx
  ON library_relations (workspace_id, from_type, from_id);

CREATE INDEX IF NOT EXISTS library_relations_to_idx
  ON library_relations (workspace_id, to_type, to_id);

CREATE TABLE IF NOT EXISTS library_properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN ('document', 'block')),
  subject_id uuid NOT NULL,
  key text NOT NULL CHECK (char_length(key) > 0),
  value_type text NOT NULL CHECK (value_type IN ('string', 'number', 'boolean', 'json')),
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, subject_type, subject_id, key)
);

CREATE INDEX IF NOT EXISTS library_properties_subject_idx
  ON library_properties (workspace_id, subject_type, subject_id);
