-- Goals remain the authority; Opening preferences retain only selection references.
ALTER TABLE course_goals DROP CONSTRAINT IF EXISTS course_goals_exam_date_check;
ALTER TABLE course_goals DROP CONSTRAINT IF EXISTS course_goals_workspace_id_course_id_kind_key;
DROP INDEX IF EXISTS course_goals_workspace_course_kind_uidx;
ALTER TABLE course_goals
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN target_date date,
  ADD COLUMN weekly_minutes integer NOT NULL DEFAULT 0 CHECK (weekly_minutes BETWEEN 0 AND 3000),
  ADD COLUMN learning_mode text NOT NULL DEFAULT 'auto' CHECK (learning_mode IN ('auto','exam','understand')),
  ADD COLUMN success_criteria text NOT NULL DEFAULT '',
  ADD COLUMN lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','maintenance','reduced','paused','archived','stopped')),
  ADD COLUMN maintenance_interval_days integer CHECK (maintenance_interval_days BETWEEN 1 AND 365),
  ADD COLUMN milestones jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN definition_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN client_key text,
  ADD COLUMN create_intent jsonb;
UPDATE course_goals SET lifecycle=CASE WHEN archived_at IS NOT NULL THEN 'archived' WHEN NOT active THEN 'paused' ELSE 'active' END,
  target_date=exam_date;
CREATE UNIQUE INDEX course_goals_workspace_client_key_uidx ON course_goals(workspace_id,client_key) WHERE client_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS courses_workspace_id_id_uidx ON courses(workspace_id,id);
CREATE TABLE course_goal_links (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  goal_id uuid NOT NULL, course_id uuid NOT NULL,
  PRIMARY KEY(workspace_id,goal_id,course_id),
  FOREIGN KEY(workspace_id,goal_id) REFERENCES course_goals(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,course_id) REFERENCES courses(workspace_id,id) ON DELETE CASCADE
);
INSERT INTO course_goal_links(workspace_id,goal_id,course_id) SELECT workspace_id,id,course_id FROM course_goals;
ALTER TABLE workspace_preferences ADD COLUMN learning_management jsonb;
CREATE TABLE course_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, course_id uuid NOT NULL,
  stable_skill_id uuid NOT NULL, knowledge_node_id uuid, requirement_key text NOT NULL, title text NOT NULL,
  position integer NOT NULL DEFAULT 0, mandatory boolean NOT NULL DEFAULT true,
  goal_ids uuid[] NOT NULL DEFAULT '{}', prerequisite_ids uuid[] NOT NULL DEFAULT '{}',
  source_refs jsonb NOT NULL DEFAULT '[]', verification jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
  lifecycle text NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','archived')),
  origin text NOT NULL DEFAULT 'extracted' CHECK(origin IN ('syllabus','confirmed','extracted')),
  approved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id), UNIQUE(workspace_id,course_id,requirement_key),
  FOREIGN KEY(workspace_id,course_id) REFERENCES courses(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX course_requirements_course_position_idx ON course_requirements(workspace_id,course_id,position,id);
