-- 0022_opening_memory_privacy.sql
-- M01: candidate / confirmed / temporary memory (privacy epoch columns reserved for M02)
CREATE TABLE IF NOT EXISTS opening_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  course_id uuid NULL,
  kind text NOT NULL CHECK (kind IN ('confirmed', 'candidate', 'temporary')),
  text text NOT NULL CHECK (char_length(text) >= 1 AND char_length(text) <= 4000),
  source_turn_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  expires_at timestamptz NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rejected', 'deleted')),
  last_decision_client_key text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opening_memories_temporary_expires_chk
    CHECK (kind <> 'temporary' OR expires_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS opening_memories_workspace_status_idx
  ON opening_memories (workspace_id, status);
CREATE INDEX IF NOT EXISTS opening_memories_workspace_course_idx
  ON opening_memories (workspace_id, course_id);
