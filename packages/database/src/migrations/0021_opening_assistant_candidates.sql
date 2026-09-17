-- 0021_opening_assistant_candidates.sql
CREATE TABLE IF NOT EXISTS opening_assistant_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES opening_conversations(id) ON DELETE CASCADE,
  source_turn_id uuid NOT NULL REFERENCES opening_turns(id) ON DELETE CASCADE,
  source_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'discarded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opening_assistant_candidates_workspace_status_idx
  ON opening_assistant_candidates (workspace_id, status);
