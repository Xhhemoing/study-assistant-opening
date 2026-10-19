-- Append-only user instructions/signals. They change strategy and answer conditions, never scores.
CREATE TABLE opening_study_intent_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  session_id uuid NOT NULL REFERENCES opening_learning_sessions(id) ON DELETE CASCADE,
  activity_id uuid NOT NULL REFERENCES opening_teaching_activities(id) ON DELETE CASCADE,
  attempt_id uuid REFERENCES opening_learning_attempts(id) ON DELETE CASCADE,
  client_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  event_kind text NOT NULL CHECK (event_kind IN ('preference','explicit_request','signal')),
  payload jsonb NOT NULL,
  resulting_intent jsonb NOT NULL,
  action text NOT NULL CHECK (action IN ('continue','diagnose','increase_challenge','clarify_intent')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT opening_study_intent_events_replay UNIQUE(workspace_id,owner_user_id,client_key),
  CONSTRAINT opening_study_intent_events_order UNIQUE(session_id,version)
);
CREATE INDEX opening_study_intent_events_attempt_idx ON opening_study_intent_events(workspace_id,owner_user_id,attempt_id,version);
-- Roll back application code first; retain this event history and its answer-condition declarations.
