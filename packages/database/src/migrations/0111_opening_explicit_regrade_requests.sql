-- Explicit regrading is a new authorization, not a retry or a new answer.
-- No backfill and no writes to historical grading/budget records.
CREATE TABLE opening_explicit_regrade_requests (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  root_observation_id uuid NOT NULL REFERENCES opening_learning_observations(id) ON DELETE CASCADE,
  expected_head_id uuid NOT NULL REFERENCES opening_learning_observations(id) ON DELETE CASCADE,
  answer_revision integer NOT NULL CHECK (answer_revision > 0),
  privacy_epoch integer NOT NULL CHECK (privacy_epoch >= 0),
  previous_grading_version integer NOT NULL CHECK (previous_grading_version >= 0),
  grading_version integer NOT NULL CHECK (grading_version = previous_grading_version + 1),
  previous_operation_id text NOT NULL,
  operation_id text NOT NULL,
  client_key text NOT NULL,
  confirmation_version text NOT NULL CHECK (confirmation_version = 'double-charge-v1'),
  work_source jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  job_id uuid REFERENCES opening_jobs(id),
  result_observation_id uuid REFERENCES opening_learning_observations(id),
  CONSTRAINT opening_explicit_regrade_client_unique UNIQUE (workspace_id, owner_user_id, client_key),
  CONSTRAINT opening_explicit_regrade_operation_unique UNIQUE (workspace_id, operation_id),
  CHECK (operation_id = 'ai-regrade:' || workspace_id::text || ':' || id::text),
  CHECK (job_id IS NULL OR confirmed_at IS NOT NULL),
  CHECK (result_observation_id IS NULL OR job_id IS NOT NULL)
);
-- Prepared tabs may coexist. Exactly one confirmation can consume a predecessor,
-- even if the tabs use different client keys, request IDs, heads or privacy epochs.
CREATE UNIQUE INDEX opening_explicit_regrade_single_successor
  ON opening_explicit_regrade_requests (workspace_id, owner_user_id, root_observation_id, answer_revision, previous_grading_version)
  WHERE confirmed_at IS NOT NULL;
CREATE INDEX opening_explicit_regrade_current
  ON opening_explicit_regrade_requests (workspace_id, owner_user_id, root_observation_id, answer_revision, grading_version DESC)
  WHERE confirmed_at IS NOT NULL;

-- Rollback: disable new admission/execution and retain the table and all fees.
-- Do not DROP the table or edit schema_migrations. Older migration runners reject
-- unknown history; rollback across 0111 needs an independently approved registry
-- procedure. Never release unknown reservations as part of rollback.
