-- 0017_opening_conversations.sql
-- T03 saved conversations, turns, and tutoring jobs (RU-02/04 plumbing).

CREATE TABLE IF NOT EXISTS opening_conversations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) > 0 AND char_length(title) <= 200),
  course_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS opening_conversations_workspace_updated_idx
  ON opening_conversations (workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS opening_turns (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES opening_conversations (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  text text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('hint', 'explain', 'listen', 'think_together')),
  status text NOT NULL CHECK (status IN ('pending', 'complete', 'failed')),
  client_key text NULL,
  learning_session_id uuid NULL,
  current_page integer NULL CHECK (current_page IS NULL OR current_page > 0),
  chunk_id uuid NULL,
  source_ids uuid[] NOT NULL DEFAULT '{}',
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS opening_turns_workspace_client_key_uidx
  ON opening_turns (workspace_id, client_key)
  WHERE client_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS opening_turns_conversation_created_idx
  ON opening_turns (conversation_id, created_at ASC);

CREATE TABLE IF NOT EXISTS opening_tutor_jobs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES opening_conversations (id) ON DELETE CASCADE,
  user_turn_id uuid NOT NULL REFERENCES opening_turns (id) ON DELETE CASCADE,
  assistant_turn_id uuid NOT NULL REFERENCES opening_turns (id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN (
    'queued', 'running', 'succeeded', 'failed', 'cancelled', 'outcome_unknown'
  )),
  mode text NOT NULL,
  error jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS opening_tutor_jobs_workspace_idx
  ON opening_tutor_jobs (workspace_id, created_at DESC);
