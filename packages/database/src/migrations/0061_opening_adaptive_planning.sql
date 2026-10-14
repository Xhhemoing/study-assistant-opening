-- Learning loop v2 (adaptive planning, L0). Additive only: new columns are nullable
-- or defaulted, so code that predates them keeps reading and writing these tables.

-- Task attribution and deferral. The FK keeps course_id resolvable: restore rejects
-- archives whose rows name a course missing from both archive and target, so a
-- dangling id would block the whole restore. Deleting a course detaches its tasks.
-- Writers still check that the course belongs to the task's workspace.
ALTER TABLE opening_tasks
  ADD COLUMN IF NOT EXISTS course_id uuid NULL REFERENCES courses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS skill_label text NULL
    CHECK (skill_label IS NULL OR char_length(skill_label) BETWEEN 1 AND 200),
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual'
    CHECK (origin IN ('manual', 'course_seed', 'retest', 'planner', 'agent')),
  ADD COLUMN IF NOT EXISTS not_before timestamptz NULL;

CREATE INDEX IF NOT EXISTS opening_tasks_course_idx
  ON opening_tasks (workspace_id, owner_user_id, course_id)
  WHERE course_id IS NOT NULL;

-- Draft provenance, planner suggestions (created only on accept) and structured reasons.
ALTER TABLE opening_plan_drafts
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'user'
    CHECK (origin IN ('user', 'auto_draft', 'coach', 'agent')),
  ADD COLUMN IF NOT EXISTS suggested_tasks jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS reasons jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS strategy_version text NULL
    CHECK (strategy_version IS NULL OR char_length(strategy_version) BETWEEN 1 AND 40);

-- Autonomy mode, coach budget and per-course goals; kept apart from planning_settings
-- because the semester form rewrites that document wholesale.
ALTER TABLE workspace_preferences
  ADD COLUMN IF NOT EXISTS adaptive_planning jsonb NULL;

-- Rollback (drops adaptive metadata; tasks, drafts and plans stay intact):
-- ALTER TABLE workspace_preferences DROP COLUMN IF EXISTS adaptive_planning;
-- ALTER TABLE opening_plan_drafts
--   DROP COLUMN IF EXISTS strategy_version, DROP COLUMN IF EXISTS reasons,
--   DROP COLUMN IF EXISTS suggested_tasks, DROP COLUMN IF EXISTS origin;
-- DROP INDEX IF EXISTS opening_tasks_course_idx;
-- ALTER TABLE opening_tasks
--   DROP COLUMN IF EXISTS not_before, DROP COLUMN IF EXISTS origin,
--   DROP COLUMN IF EXISTS skill_label, DROP COLUMN IF EXISTS course_id;
