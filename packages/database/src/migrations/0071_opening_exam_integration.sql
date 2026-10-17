-- Explicitly opt in to course evidence. Existing isolated sprint history is not backfilled.
-- Cross-branch references defer checks so deleting an entire workspace can
-- cascade both sprint and canonical rows; deleting a referenced fact alone still fails.
CREATE TABLE opening_exam_bindings (
  sprint_id uuid PRIMARY KEY REFERENCES opening_exam_sprints(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  binding jsonb NOT NULL CHECK (jsonb_typeof(binding)='object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE opening_exam_integration_commands (
  id uuid PRIMARY KEY,
  sprint_id uuid NOT NULL REFERENCES opening_exam_sprints(id) ON DELETE CASCADE,
  client_key text NOT NULL,
  intent jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sprint_id,client_key)
);
CREATE TABLE opening_exam_source_mappings (
  sprint_id uuid NOT NULL REFERENCES opening_exam_sprints(id) ON DELETE CASCADE,
  source_item_id text NOT NULL,
  skill_ids text[] NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sprint_id,source_item_id)
);
CREATE TABLE opening_exam_attempt_links (
  id uuid PRIMARY KEY,
  sprint_id uuid NOT NULL REFERENCES opening_exam_sprints(id) ON DELETE CASCADE,
  exam_attempt_id text NOT NULL,
  learning_attempt_id uuid NOT NULL UNIQUE REFERENCES opening_learning_attempts(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  node_id uuid NOT NULL,
  requirement_key text NOT NULL,
  first_family_exposure boolean NOT NULL,
  delayed_earliest_at timestamptz,
  submitted_answer text,
  captured_at timestamptz,
  observation_id uuid UNIQUE REFERENCES opening_learning_observations(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  publication text NOT NULL CHECK (publication IN ('pending_answer','pending_mock','published')),
  prediction jsonb,
  UNIQUE (sprint_id,exam_attempt_id),
  CHECK ((submitted_answer IS NULL) = (captured_at IS NULL)),
  CHECK ((publication='published') = (observation_id IS NOT NULL))
);
CREATE TABLE opening_exam_help_receipts (
  id uuid PRIMARY KEY,
  attempt_link_id uuid NOT NULL REFERENCES opening_exam_attempt_links(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('hint','solution','external')),
  delivered_at timestamptz NOT NULL,
  history_revision bigint NOT NULL,
  workspace_history_revision bigint NOT NULL,
  content_snapshot text,
  UNIQUE (attempt_link_id,kind)
);
CREATE TABLE opening_exam_source_observations (
  sprint_id uuid NOT NULL REFERENCES opening_exam_sprints(id) ON DELETE CASCADE,
  source_record_id text NOT NULL,
  skill_ids text[] NOT NULL,
  observation_id uuid NOT NULL UNIQUE REFERENCES opening_learning_observations(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  PRIMARY KEY (sprint_id,source_record_id)
);
-- Additive rollback: retain all tables and canonical evidence; roll back only the
-- application after a complete pg_dump. Redacted learner export is not a restore.
