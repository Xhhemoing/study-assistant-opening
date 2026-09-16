-- 0016_opening_sources.sql
-- Opening source identity for RU-01 membership ownership resolution.
-- Course association is membership-only (no course_id on this table).

CREATE TABLE IF NOT EXISTS opening_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) > 0 AND char_length(name) <= 180),
  mime text NOT NULL,
  bytes integer NOT NULL CHECK (bytes > 0),
  sha256 text NOT NULL CHECK (char_length(sha256) = 64),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  upload_state text NOT NULL CHECK (upload_state IN ('pending', 'uploaded', 'rejected')),
  parse_state text NOT NULL CHECK (parse_state IN (
    'not_started', 'queued', 'running', 'ready', 'failed', 'unsupported'
  )),
  error jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS opening_sources_workspace_idx
  ON opening_sources (workspace_id);
