-- First-party timing/click measurements only; no prompts, responses or source text.
CREATE TABLE opening_learning_experience_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('first_text','next_step_shown','next_step_started')),
  target_type text NOT NULL CHECK(target_type IN ('job','activity','course','conversation')),
  target_id uuid NOT NULL,
  local_day date NOT NULL,
  duration_ms integer CHECK(duration_ms BETWEEN 1 AND 600000),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK((kind='first_text' AND target_type='job' AND duration_ms IS NOT NULL)
    OR (kind<>'first_text' AND target_type<>'job' AND duration_ms IS NULL)),
  UNIQUE(workspace_id,owner_user_id,event_key)
);
CREATE INDEX opening_learning_experience_window_idx ON opening_learning_experience_events(workspace_id,owner_user_id,recorded_at);
