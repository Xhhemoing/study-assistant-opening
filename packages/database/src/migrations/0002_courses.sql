-- 0002_courses.sql
-- Long-lived courses and relational asset membership (no content copy).

CREATE TABLE IF NOT EXISTS courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  title text NOT NULL,
  slug text NOT NULL,
  description text NOT NULL DEFAULT '',
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz NULL,
  UNIQUE (workspace_id, slug)
);

CREATE INDEX IF NOT EXISTS courses_workspace_idx
  ON courses (workspace_id)
  WHERE archived_at IS NULL;

-- Membership points at a workspace-scoped asset by type + id.
-- Document content lives only in library_* tables.
CREATE TABLE IF NOT EXISTS course_asset_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  asset_type text NOT NULL CHECK (asset_type IN (
    'source', 'document', 'block', 'card', 'practice-item', 'artifact'
  )),
  asset_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('core', 'optional', 'reference', 'archive')),
  sort_order integer NOT NULL DEFAULT 0,
  visibility text NOT NULL CHECK (visibility IN ('private', 'course', 'public')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, asset_type, asset_id)
);

CREATE INDEX IF NOT EXISTS course_asset_memberships_course_idx
  ON course_asset_memberships (course_id, sort_order);

CREATE INDEX IF NOT EXISTS course_asset_memberships_asset_idx
  ON course_asset_memberships (workspace_id, asset_type, asset_id);

-- Ensure membership workspace matches course workspace.
CREATE OR REPLACE FUNCTION course_membership_workspace_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  course_ws uuid;
BEGIN
  SELECT workspace_id INTO course_ws FROM courses WHERE id = NEW.course_id;
  IF course_ws IS NULL THEN
    RAISE EXCEPTION 'course % not found', NEW.course_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF course_ws <> NEW.workspace_id THEN
    RAISE EXCEPTION 'membership workspace_id must match course workspace'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS course_asset_memberships_workspace_guard
  ON course_asset_memberships;
CREATE TRIGGER course_asset_memberships_workspace_guard
  BEFORE INSERT OR UPDATE ON course_asset_memberships
  FOR EACH ROW
  EXECUTE FUNCTION course_membership_workspace_guard();
