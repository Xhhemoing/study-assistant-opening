-- Additive metadata only: neither historical papers nor AI proposals grade learning evidence.
-- Rollback: retain both tables and their records, and roll back only the application.
-- Take a complete pg_dump before migration; use that backup if database restoration is required.
CREATE TABLE opening_exam_papers (
  id uuid PRIMARY KEY,
  sprint_id uuid NOT NULL REFERENCES opening_exam_sprints(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES opening_sources(id) ON DELETE CASCADE,
  source_version integer NOT NULL CHECK (source_version >= 0),
  teacher text NOT NULL CHECK (char_length(teacher) BETWEEN 1 AND 100),
  year integer NOT NULL CHECK (year BETWEEN 1900 AND 2200),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('past_exam','sample','exercise')),
  skills jsonb NOT NULL CHECK (jsonb_typeof(skills)='array'),
  client_key text NOT NULL,
  intent jsonb NOT NULL CHECK (jsonb_typeof(intent)='object'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opening_exam_paper_command_unique UNIQUE (workspace_id,owner_user_id,client_key),
  CONSTRAINT opening_exam_paper_source_unique UNIQUE (sprint_id,source_id,source_version)
);
CREATE INDEX opening_exam_paper_course_idx ON opening_exam_papers(workspace_id,owner_user_id,course_id);

CREATE TABLE opening_exam_reviews (
  id uuid PRIMARY KEY,
  sprint_id uuid NOT NULL REFERENCES opening_exam_sprints(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_item_id text NOT NULL,
  work_source_id uuid NOT NULL REFERENCES opening_sources(id) ON DELETE CASCADE,
  work_source_version integer NOT NULL CHECK (work_source_version >= 0),
  reference_source_id uuid NOT NULL REFERENCES opening_sources(id) ON DELETE CASCADE,
  reference_source_version integer NOT NULL CHECK (reference_source_version >= 0),
  answer_text text NOT NULL DEFAULT '',
  client_key text NOT NULL,
  intent jsonb NOT NULL CHECK (jsonb_typeof(intent)='object'),
  status text NOT NULL CHECK (status IN ('pending','ready','unknown','failed')),
  proposal jsonb CHECK (proposal IS NULL OR jsonb_typeof(proposal)='object'),
  model_label text,
  privacy_epoch bigint NOT NULL CHECK (privacy_epoch >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opening_exam_review_command_unique UNIQUE (workspace_id,owner_user_id,client_key),
  CHECK ((status='ready') = (proposal IS NOT NULL))
);
CREATE INDEX opening_exam_review_sprint_idx ON opening_exam_reviews(sprint_id,created_at,id);
