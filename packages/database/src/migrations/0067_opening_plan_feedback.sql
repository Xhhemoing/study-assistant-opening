-- Planning actions are not learning observations. No historical feedback is inferred.
CREATE TABLE opening_plan_feedback (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES opening_tasks(id) ON DELETE CASCADE,
  task_version integer NOT NULL CHECK (task_version > 0),
  action text NOT NULL CHECK (action IN ('done', 'skipped', 'deferred', 'resumed')),
  reason text CHECK (reason IN ('time_short', 'too_hard', 'too_easy', 'not_relevant', 'other', 'prefer_not_say')),
  origin text NOT NULL CHECK (origin IN ('manual', 'course_seed', 'retest', 'planner', 'agent')),
  requirement_key text,
  suggestion_kind text CHECK (suggestion_kind IN ('weak_skill', 'review_cards', 'new_skill', 'course_pace')),
  not_before timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opening_plan_feedback_task_version_action_uidx UNIQUE (task_id, task_version, action)
);
CREATE INDEX opening_plan_feedback_scope_recorded_idx
  ON opening_plan_feedback (workspace_id, owner_user_id, recorded_at);

-- Deploy before the application. Application rollback keeps the additive table
-- and its records; export them before any intentional DROP TABLE rollback.
