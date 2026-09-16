-- L01 paper learning sessions / help exposure / problem binding / observations
-- Prerequisite migrations (reserved): 0016 sources/jobs, 0017 conversations, 0018 memories/privacy.
-- If 0017/0018 are not yet applied, apply those first. Do not renumber if siblings claimed 0017/0018.

CREATE TABLE IF NOT EXISTS opening_learning_sessions (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  owner_user_id UUID NOT NULL,
  course_id UUID NOT NULL,
  skill_label TEXT NOT NULL CHECK (char_length(skill_label) BETWEEN 1 AND 200),
  source_ids UUID[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS opening_learning_sessions_workspace_course_idx
  ON opening_learning_sessions (workspace_id, course_id);

CREATE TABLE IF NOT EXISTS opening_problem_refs (
  problem_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  session_id UUID NOT NULL REFERENCES opening_learning_sessions(id) ON DELETE CASCADE,
  source_id UUID NOT NULL,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  physical_page INTEGER NULL CHECK (physical_page IS NULL OR physical_page > 0),
  chunk_id UUID NULL,
  stem_snapshot TEXT NOT NULL CHECK (char_length(stem_snapshot) BETWEEN 1 AND 2000),
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('reference_item', 'student_work', 'unknown')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS opening_problem_refs_session_idx
  ON opening_problem_refs (session_id);

CREATE TABLE IF NOT EXISTS opening_help_exposures (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  session_id UUID NOT NULL REFERENCES opening_learning_sessions(id) ON DELETE CASCADE,
  problem_id UUID NULL,
  turn_id UUID NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('hinted', 'revealed')),
  delivered BOOLEAN NOT NULL CHECK (delivered = TRUE),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS opening_help_exposures_session_idx
  ON opening_help_exposures (session_id);

CREATE TABLE IF NOT EXISTS opening_learning_observations (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  owner_user_id UUID NOT NULL,
  session_id UUID NOT NULL REFERENCES opening_learning_sessions(id) ON DELETE CASCADE,
  course_id UUID NOT NULL,
  skill_label TEXT NOT NULL CHECK (char_length(skill_label) BETWEEN 1 AND 200),
  source_ids UUID[] NOT NULL DEFAULT '{}',
  problem_id UUID NULL,
  retest_id UUID NULL,
  answer TEXT NOT NULL CHECK (char_length(answer) <= 20000),
  outcome TEXT NOT NULL CHECK (outcome IN ('correct', 'incorrect', 'unverified')),
  assistance TEXT NOT NULL CHECK (assistance IN ('independent', 'hinted', 'revealed', 'unknown')),
  client_key TEXT NOT NULL CHECK (char_length(client_key) BETWEEN 8 AND 200),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_turn_ids UUID[] NOT NULL DEFAULT '{}',
  verdict_source TEXT NOT NULL CHECK (
    verdict_source IN ('self_report', 'reference_checked', 'model_suggestion', 'unknown')
  ),
  reference_source_id UUID NULL,
  evidence_verdict TEXT NOT NULL DEFAULT 'MASTERY_NOT_ESTABLISHED'
    CHECK (evidence_verdict IN (
      'FLOW_VERIFIED', 'LEARNING_EFFECT_OBSERVED', 'MASTERY_NOT_ESTABLISHED'
    )),
  UNIQUE (workspace_id, client_key)
);

CREATE INDEX IF NOT EXISTS opening_learning_observations_session_idx
  ON opening_learning_observations (session_id);

CREATE INDEX IF NOT EXISTS opening_learning_observations_course_idx
  ON opening_learning_observations (workspace_id, course_id);
