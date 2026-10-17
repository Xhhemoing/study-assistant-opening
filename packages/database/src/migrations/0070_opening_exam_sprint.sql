-- An opt-in exam sprint is isolated from career mastery and BKT measurements.
-- Freeze the reviewed pack at first write so later content releases cannot
-- silently change answers, provenance, or already recorded learning evidence.
CREATE TABLE opening_exam_sprints (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pack_snapshot jsonb NOT NULL CHECK (jsonb_typeof(pack_snapshot) = 'object'),
  state jsonb NOT NULL CHECK (jsonb_typeof(state) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opening_exam_sprint_scope_unique UNIQUE (workspace_id, owner_user_id)
);

-- Receipts are appended in the same transaction as the state transition.
-- There is intentionally no application update/delete path for these records.
CREATE TABLE opening_exam_sprint_commands (
  id uuid PRIMARY KEY,
  sprint_id uuid NOT NULL REFERENCES opening_exam_sprints(id) ON DELETE CASCADE,
  client_key text NOT NULL CHECK (length(client_key) BETWEEN 8 AND 200),
  intent jsonb NOT NULL CHECK (jsonb_typeof(intent) = 'object'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opening_exam_sprint_command_key_unique UNIQUE (sprint_id, client_key)
);
CREATE INDEX opening_exam_sprint_command_recorded_idx
  ON opening_exam_sprint_commands (sprint_id, recorded_at, id);

-- Apply before the application. Roll back the application while retaining both
-- tables and all receipts. Any intentional removal requires a full DB backup;
-- the learner-facing JSON export is redacted and is not a recovery backup.
