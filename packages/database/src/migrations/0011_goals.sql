-- 0011_goals.sql
-- Multiple per-course goals with time windows and deterministic merge inputs.

CREATE TABLE IF NOT EXISTS course_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'final-exam', 'entrance-exam', 'interest', 'maintenance', 'custom'
  )),
  title text NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  intensity double precision NOT NULL DEFAULT 0.5 CHECK (intensity >= 0 AND intensity <= 1),
  abilities jsonb NOT NULL,
  strategy_version text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  exam_date date NULL,
  user_override jsonb NULL,
  archived_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, course_id, kind),
  CHECK (exam_date IS NULL OR exam_date > CURRENT_DATE - 1)
);

CREATE INDEX IF NOT EXISTS course_goals_course_active_idx
  ON course_goals (course_id, active)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS goal_time_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  goal_id uuid NOT NULL REFERENCES course_goals (id) ON DELETE CASCADE,
  phase text NOT NULL CHECK (phase IN (
    'foundation', 'consolidation', 'rehearsal', 'maintenance'
  )),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  modifier jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, goal_id, phase),
  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS goal_time_windows_goal_idx
  ON goal_time_windows (goal_id, starts_at, ends_at);

-- Ensure a goal's workspace matches its course's workspace.
CREATE OR REPLACE FUNCTION course_goal_workspace_guard()
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
    RAISE EXCEPTION 'goal workspace_id must match course workspace'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS course_goals_workspace_guard ON course_goals;
CREATE TRIGGER course_goals_workspace_guard
  BEFORE INSERT OR UPDATE ON course_goals
  FOR EACH ROW
  EXECUTE FUNCTION course_goal_workspace_guard();
