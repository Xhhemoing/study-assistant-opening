-- P02: tasks, timetable sessions, plan drafts/acceptances (Heidi-assigned 0024)
-- Does not reuse legacy goal models as campus tasks.

CREATE TABLE IF NOT EXISTS opening_tasks (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 240),
  minutes INTEGER NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
  due_at TIMESTAMPTZ NULL,
  due_text TEXT NULL CHECK (due_text IS NULL OR char_length(due_text) BETWEEN 1 AND 200),
  priority DOUBLE PRECISION NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'skipped')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  candidate_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (due_at IS NULL OR due_text IS NULL)
);
CREATE INDEX IF NOT EXISTS opening_tasks_workspace_status_idx
  ON opening_tasks (workspace_id, status);

CREATE TABLE IF NOT EXISTS opening_timetable_sessions (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL,
  course_name TEXT NOT NULL CHECK (char_length(course_name) BETWEEN 1 AND 200),
  course_id UUID NULL,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  weeks INTEGER[] NOT NULL,
  start_period INTEGER NOT NULL CHECK (start_period > 0),
  end_period INTEGER NOT NULL CHECK (end_period > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (start_period <= end_period)
);
CREATE INDEX IF NOT EXISTS opening_timetable_workspace_idx
  ON opening_timetable_sessions (workspace_id);

CREATE TABLE IF NOT EXISTS opening_hard_blocks (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL,
  day DATE NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('class', 'sleep', 'meal', 'locked')),
  source TEXT NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (start_at < end_at)
);
CREATE INDEX IF NOT EXISTS opening_hard_blocks_day_idx
  ON opening_hard_blocks (workspace_id, day);

CREATE TABLE IF NOT EXISTS opening_plan_state (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  accepted_version INTEGER NOT NULL DEFAULT 0 CHECK (accepted_version >= 0),
  accepted_blocks JSONB NOT NULL DEFAULT '[]'::jsonb,
  hard_blocks_fingerprint TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, day)
);

CREATE TABLE IF NOT EXISTS opening_plan_drafts (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL,
  day DATE NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  base_version INTEGER NOT NULL CHECK (base_version >= 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'accepted', 'rejected')),
  blocks JSONB NOT NULL DEFAULT '[]'::jsonb,
  unscheduled_task_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  input_snapshot JSONB NOT NULL,
  hard_blocks_fingerprint TEXT NOT NULL,
  propose_client_key TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opening_plan_drafts_day_idx
  ON opening_plan_drafts (workspace_id, day, status);

CREATE TABLE IF NOT EXISTS opening_plan_acceptances (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_key TEXT NOT NULL CHECK (char_length(client_key) BETWEEN 8 AND 200),
  draft_id UUID NOT NULL REFERENCES opening_plan_drafts(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  accepted_version INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, client_key)
);
