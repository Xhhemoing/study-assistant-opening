-- K01: course knowledge snapshots (version CAS) + allow build-course-knowledge jobs.
ALTER TABLE opening_jobs DROP CONSTRAINT IF EXISTS opening_jobs_kind_check;
ALTER TABLE opening_jobs
  ADD CONSTRAINT opening_jobs_kind_check
  CHECK (kind IN ('parse','tutor','retest','remind','build-course-knowledge'));

CREATE TABLE opening_course_knowledge (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  snapshot JSONB NOT NULL,
  source_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, course_id),
  UNIQUE (course_id)
);

CREATE INDEX opening_course_knowledge_owner_idx
  ON opening_course_knowledge (workspace_id, owner_user_id);

-- Rollback:
-- DROP TABLE opening_course_knowledge;
-- ALTER TABLE opening_jobs DROP CONSTRAINT IF EXISTS opening_jobs_kind_check;
-- ALTER TABLE opening_jobs ADD CONSTRAINT opening_jobs_kind_check
--   CHECK (kind IN ('parse','tutor','retest','remind'));
