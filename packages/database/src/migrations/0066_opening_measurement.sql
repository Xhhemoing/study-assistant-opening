-- Opt-in measurement records are isolated from production learning/mastery facts.
-- Rollback: deploy the prior app while retaining these tables and their evidence.
-- Export all trials before intentionally dropping the three tables in reverse order.
CREATE TABLE opening_measurement_trials (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  bank_version TEXT NOT NULL,
  models JSONB NOT NULL,
  catalog JSONB NOT NULL,
  selection_policy TEXT NOT NULL CHECK (selection_policy = 'fixed-common-probes-v1'),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed')),
  client_key TEXT NOT NULL CHECK (char_length(client_key) BETWEEN 8 AND 200),
  create_intent JSONB NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  practice_completed_at TIMESTAMPTZ,
  UNIQUE (workspace_id, owner_user_id, client_key),
  UNIQUE (workspace_id, owner_user_id, unit_id)
);

CREATE TABLE opening_measurement_attempts (
  id UUID PRIMARY KEY,
  trial_id UUID NOT NULL REFERENCES opening_measurement_trials(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  item_snapshot JSONB NOT NULL,
  first_attempt BOOLEAN NOT NULL,
  predictions JSONB NOT NULL,
  presented_at TIMESTAMPTZ NOT NULL,
  due_at TIMESTAMPTZ,
  help_events JSONB NOT NULL DEFAULT '[]'::jsonb,
  answer TEXT,
  outcome TEXT CHECK (outcome IN ('correct', 'incorrect', 'skipped')),
  answered_at TIMESTAMPTZ,
  feedback TEXT,
  retracted_at TIMESTAMPTZ,
  retraction_reason TEXT,
  UNIQUE (trial_id, ordinal),
  CHECK ((outcome IS NULL) = (answered_at IS NULL)),
  CHECK (answered_at IS NULL OR answered_at >= presented_at),
  CHECK (due_at IS NULL OR presented_at >= due_at),
  CHECK ((retracted_at IS NULL) = (retraction_reason IS NULL)),
  CHECK (retracted_at IS NULL OR outcome IS NOT NULL)
);
CREATE UNIQUE INDEX opening_measurement_one_pending
  ON opening_measurement_attempts(trial_id) WHERE outcome IS NULL;

-- Receipts retain the original command intent for idempotent retries. They also
-- preserve the server event time without treating missing answers as incorrect.
CREATE TABLE opening_measurement_commands (
  id UUID PRIMARY KEY,
  trial_id UUID NOT NULL REFERENCES opening_measurement_trials(id) ON DELETE CASCADE,
  attempt_id UUID REFERENCES opening_measurement_attempts(id) ON DELETE CASCADE,
  client_key TEXT NOT NULL CHECK (char_length(client_key) BETWEEN 8 AND 200),
  intent JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (trial_id, client_key)
);
