-- 0018_opening_jobs_outbox_budget.sql
-- F03 jobs/outbox/budget fills the reserved 0018 slot. Memories/privacy moves to 0020+.
-- This documented deviation leaves committed 0016/0017/0019 untouched.
CREATE TABLE IF NOT EXISTS opening_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('parse','tutor','retest','remind')),
  payload jsonb NOT NULL,
  result jsonb,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','failed','cancelled','outcome_unknown')),
  privacy_epoch integer NOT NULL DEFAULT 0 CHECK (privacy_epoch >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, key)
);
COMMENT ON COLUMN opening_jobs.payload IS 'Source IDs only; never API keys or signed URLs.';
CREATE INDEX IF NOT EXISTS opening_jobs_workspace_idx ON opening_jobs(workspace_id);

CREATE TABLE IF NOT EXISTS opening_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES opening_jobs(id) ON DELETE CASCADE,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','published','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opening_outbox_pending_idx ON opening_outbox(state, created_at);

CREATE TABLE IF NOT EXISTS opening_budget_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  request_id text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','completed','released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opening_budget_workspace_idx ON opening_budget_reservations(workspace_id, state);
