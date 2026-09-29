CREATE TABLE opening_learning_history_revisions (
  workspace_id uuid NOT NULL, owner_user_id uuid NOT NULL, course_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (workspace_id, owner_user_id, course_id)
);
CREATE TABLE opening_learning_item_versions (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL, owner_user_id uuid NOT NULL,
  course_id uuid NOT NULL, problem_id uuid NOT NULL, source_id uuid NOT NULL,
  source_version integer NOT NULL CHECK (source_version >= 0),
  physical_page integer, chunk_id uuid, stem_snapshot text NOT NULL, artifact_kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX opening_learning_item_versions_problem ON opening_learning_item_versions(workspace_id, problem_id, created_at);
CREATE TABLE opening_learning_attempts (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL, owner_user_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES opening_learning_sessions(id) ON DELETE CASCADE,
  course_id uuid NOT NULL, skill_label text NOT NULL, requirement_key text,
  problem_id uuid, item_version_id uuid REFERENCES opening_learning_item_versions(id),
  source_ids uuid[] NOT NULL DEFAULT '{}', source_versions jsonb NOT NULL DEFAULT '{}',
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(), submitted_at timestamptz,
  observation_id uuid, client_key text NOT NULL, create_intent jsonb NOT NULL,
  history_revision bigint NOT NULL,
  UNIQUE (workspace_id, owner_user_id, client_key)
);
ALTER TABLE opening_learning_observations
  ADD COLUMN attempt_id uuid REFERENCES opening_learning_attempts(id),
  ADD COLUMN item_version_id uuid REFERENCES opening_learning_item_versions(id),
  ADD COLUMN requirement_key text,
  ADD COLUMN started_at timestamptz,
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN recorded_at timestamptz,
  ADD COLUMN source_versions jsonb,
  ADD COLUMN reference_check jsonb,
  ADD COLUMN submitted_intent jsonb,
  ADD COLUMN history_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE opening_help_exposures
  ADD COLUMN attempt_id uuid REFERENCES opening_learning_attempts(id),
  ADD COLUMN delivered_at timestamptz,
  ADD COLUMN history_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE opening_turns ADD COLUMN attempt_id uuid REFERENCES opening_learning_attempts(id);
-- Existing committed rows establish a starting watermark. Old attempt/version/timing facts remain NULL.
INSERT INTO opening_learning_history_revisions(workspace_id,owner_user_id,course_id,revision)
SELECT workspace_id,owner_user_id,course_id,1 FROM opening_learning_sessions GROUP BY workspace_id,owner_user_id,course_id;
UPDATE opening_learning_observations SET history_revision = 1;
UPDATE opening_help_exposures SET history_revision = 1;
CREATE TABLE opening_source_versions (
  source_id uuid NOT NULL, version integer NOT NULL CHECK (version >= 0), workspace_id uuid NOT NULL,
  bytes bigint, sha256 text, availability text NOT NULL DEFAULT 'unknown'
    CHECK (availability IN ('available','unavailable','unknown')),
  PRIMARY KEY(source_id,version)
);
-- Only the current uploaded version has provable metadata; old versions are never assigned today's digest.
INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
SELECT id,version,workspace_id,bytes,sha256,'available' FROM opening_sources WHERE upload_state = 'uploaded';
