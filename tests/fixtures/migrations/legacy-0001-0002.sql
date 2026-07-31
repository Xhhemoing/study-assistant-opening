-- Legacy schema after 0001_library.sql and 0002_courses.sql, before identity.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE library_documents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  title text NOT NULL,
  lifecycle text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  current_revision_number integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz NULL
);

CREATE TABLE library_blocks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES library_documents (id) ON DELETE CASCADE,
  type text NOT NULL,
  position integer NOT NULL,
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, position),
  UNIQUE (workspace_id, id)
);

CREATE TABLE library_revisions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES library_documents (id) ON DELETE CASCADE,
  revision_number integer NOT NULL,
  parent_revision_number integer NULL,
  title text NOT NULL,
  lifecycle text NOT NULL,
  reason text NOT NULL DEFAULT 'edit',
  blocks jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, revision_number)
);

CREATE OR REPLACE FUNCTION library_reject_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'library_revisions is append-only'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER library_revisions_no_update
  BEFORE UPDATE ON library_revisions
  FOR EACH ROW EXECUTE FUNCTION library_reject_revision_mutation();
CREATE TRIGGER library_revisions_no_delete
  BEFORE DELETE ON library_revisions
  FOR EACH ROW EXECUTE FUNCTION library_reject_revision_mutation();

CREATE TABLE library_relations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  from_type text NOT NULL,
  from_id uuid NOT NULL,
  to_type text NOT NULL,
  to_id uuid NOT NULL,
  relation_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE library_properties (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  key text NOT NULL,
  value_type text NOT NULL,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE courses (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  title text NOT NULL,
  slug text NOT NULL,
  description text NOT NULL DEFAULT '',
  schema_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz NULL,
  UNIQUE (workspace_id, slug)
);

CREATE TABLE course_asset_memberships (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  asset_type text NOT NULL,
  asset_id uuid NOT NULL,
  role text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  visibility text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (id)
VALUES ('0001_library.sql'), ('0002_courses.sql');
