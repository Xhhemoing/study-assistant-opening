-- 0015_practice_content.sql
-- Versioned practice packages, syllabus points, item versions, and
-- server-observed practice sessions. Workspace identity is never taken
-- from request JSON; guards bind rows to the principal workspace.

CREATE TABLE IF NOT EXISTS content_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) > 0),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS syllabus_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  package_id uuid NOT NULL REFERENCES content_packages (id) ON DELETE CASCADE,
  parent_id uuid NULL REFERENCES syllabus_nodes (id),
  code text NOT NULL CHECK (char_length(code) > 0),
  title text NOT NULL CHECK (char_length(title) > 0),
  sort_order integer NOT NULL,
  UNIQUE (workspace_id, id),
  UNIQUE (package_id, code)
);

CREATE TABLE IF NOT EXISTS practice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  package_id uuid NOT NULL REFERENCES content_packages (id) ON DELETE CASCADE,
  current_version integer NOT NULL CHECK (current_version > 0),
  archived_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS practice_item_versions (
  practice_item_id uuid NOT NULL REFERENCES practice_items (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  syllabus_point_id uuid NOT NULL REFERENCES syllabus_nodes (id),
  kind text NOT NULL CHECK (kind IN ('multiple_choice', 'short_answer', 'checkpoint')),
  stem text NOT NULL CHECK (char_length(stem) > 0),
  options jsonb NULL CHECK (options IS NULL OR jsonb_typeof(options) = 'array'),
  answer_rule jsonb NOT NULL CHECK (jsonb_typeof(answer_rule) = 'object'),
  answer_display text NOT NULL CHECK (char_length(answer_display) > 0),
  hints jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(hints) = 'array'),
  ability_slice text NOT NULL CHECK (
    ability_slice IN ('recognition', 'recall', 'procedure', 'transfer', 'expression')
  ),
  estimated_minutes integer NOT NULL CHECK (estimated_minutes > 0),
  source jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source) = 'object'),
  review_status text NOT NULL CHECK (review_status IN ('draft', 'reviewed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (practice_item_id, version)
);

CREATE TABLE IF NOT EXISTS practice_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  practice_item_id uuid NOT NULL REFERENCES practice_items (id),
  content_version integer NOT NULL CHECK (content_version > 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  hint_count integer NOT NULL DEFAULT 0 CHECK (hint_count >= 0),
  answer_revealed_at timestamptz NULL,
  submitted_at timestamptz NULL,
  submission_idempotency_key text NULL,
  UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS practice_sessions_workspace_owner_idx
  ON practice_sessions (workspace_id, owner_user_id, started_at DESC);

CREATE OR REPLACE FUNCTION practice_content_workspace_exists()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'workspace % not found', NEW.workspace_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION practice_child_workspace_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_workspace uuid;
BEGIN
  SELECT workspace_id INTO parent_workspace FROM content_packages WHERE id = NEW.package_id;
  IF parent_workspace IS NULL THEN
    RAISE EXCEPTION 'content package % not found', NEW.package_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF parent_workspace <> NEW.workspace_id THEN
    RAISE EXCEPTION 'practice content must stay in the same workspace'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION practice_version_workspace_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  item_workspace uuid;
  point_workspace uuid;
BEGIN
  SELECT workspace_id INTO item_workspace FROM practice_items WHERE id = NEW.practice_item_id;
  SELECT workspace_id INTO point_workspace FROM syllabus_nodes WHERE id = NEW.syllabus_point_id;
  IF item_workspace IS NULL THEN
    RAISE EXCEPTION 'practice item % not found', NEW.practice_item_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF point_workspace IS NULL THEN
    RAISE EXCEPTION 'syllabus point % not found', NEW.syllabus_point_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF item_workspace <> NEW.workspace_id OR point_workspace <> NEW.workspace_id THEN
    RAISE EXCEPTION 'practice content must stay in the same workspace'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION practice_session_workspace_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  workspace_owner uuid;
  item_workspace uuid;
BEGIN
  SELECT owner_user_id INTO workspace_owner FROM workspaces WHERE id = NEW.workspace_id;
  SELECT workspace_id INTO item_workspace FROM practice_items WHERE id = NEW.practice_item_id;
  IF workspace_owner IS NULL THEN
    RAISE EXCEPTION 'workspace % not found', NEW.workspace_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF workspace_owner <> NEW.owner_user_id THEN
    RAISE EXCEPTION 'practice session owner must match workspace owner'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF item_workspace IS NULL OR item_workspace <> NEW.workspace_id THEN
    RAISE EXCEPTION 'practice session item must stay in the same workspace'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS content_packages_workspace_guard ON content_packages;
CREATE TRIGGER content_packages_workspace_guard
  BEFORE INSERT OR UPDATE ON content_packages
  FOR EACH ROW EXECUTE FUNCTION practice_content_workspace_exists();

DROP TRIGGER IF EXISTS syllabus_nodes_workspace_guard ON syllabus_nodes;
CREATE TRIGGER syllabus_nodes_workspace_guard
  BEFORE INSERT OR UPDATE ON syllabus_nodes
  FOR EACH ROW EXECUTE FUNCTION practice_child_workspace_guard();

DROP TRIGGER IF EXISTS practice_items_workspace_guard ON practice_items;
CREATE TRIGGER practice_items_workspace_guard
  BEFORE INSERT OR UPDATE ON practice_items
  FOR EACH ROW EXECUTE FUNCTION practice_child_workspace_guard();

DROP TRIGGER IF EXISTS practice_item_versions_workspace_guard ON practice_item_versions;
CREATE TRIGGER practice_item_versions_workspace_guard
  BEFORE INSERT OR UPDATE ON practice_item_versions
  FOR EACH ROW EXECUTE FUNCTION practice_version_workspace_guard();

DROP TRIGGER IF EXISTS practice_sessions_workspace_guard ON practice_sessions;
CREATE TRIGGER practice_sessions_workspace_guard
  BEFORE INSERT OR UPDATE ON practice_sessions
  FOR EACH ROW EXECUTE FUNCTION practice_session_workspace_guard();
