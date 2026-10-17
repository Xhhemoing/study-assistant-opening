-- Explicit suggestion rejection is planning feedback, never a scored observation.
CREATE TABLE opening_suggestion_feedback (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL REFERENCES opening_plan_drafts(id) ON DELETE CASCADE,
  day date NOT NULL,
  suggestion_key text NOT NULL,
  identity text NOT NULL,
  suggestion_kind text NOT NULL CHECK (suggestion_kind IN ('weak_skill', 'review_cards', 'new_skill', 'course_pace')),
  course_id uuid REFERENCES courses(id) ON DELETE SET NULL,
  requirement_key text,
  reason text CHECK (reason IN ('time_short', 'too_hard', 'too_easy', 'not_relevant', 'other', 'prefer_not_say')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  client_key text NOT NULL,
  intent jsonb NOT NULL,
  CONSTRAINT opening_suggestion_feedback_client_idx UNIQUE (workspace_id, owner_user_id, client_key),
  CONSTRAINT opening_suggestion_feedback_identity_idx UNIQUE (workspace_id, owner_user_id, day, identity)
);
CREATE INDEX opening_suggestion_feedback_scope_recorded_idx
  ON opening_suggestion_feedback (workspace_id, owner_user_id, recorded_at);

-- Undo closes only untouched coach-created tasks. It is not a learner skip.
ALTER TABLE opening_tasks ADD COLUMN close_source text
  CHECK (close_source IN ('learner', 'system'));
ALTER TABLE opening_plan_acceptances
  ADD COLUMN source text NOT NULL DEFAULT 'learner' CHECK (source IN ('learner', 'coach')),
  ADD COLUMN before_blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN created_task_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN undone_at timestamptz,
  ADD COLUMN undo_client_key text,
  ADD COLUMN undo_result_version integer,
  ADD COLUMN undo_intent jsonb,
  ADD COLUMN undo_result jsonb;
CREATE UNIQUE INDEX opening_plan_acceptances_undo_client_idx
  ON opening_plan_acceptances (workspace_id, undo_client_key) WHERE undo_client_key IS NOT NULL;

-- Roll back application first. Retain additive feedback/receipts for audit/export.
-- A destructive schema rollback requires exporting these records before dropping
-- the table, index, and added columns. No accepted plan or learning fact is deleted.
