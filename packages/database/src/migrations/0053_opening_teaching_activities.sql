-- V2-04: teaching activity context (option A history revisions; A1+A2 activity_id backfill).
-- Does NOT alter opening_learning_history_revisions PK, retest, skill_evidence, or course_knowledge course_id.

CREATE TABLE opening_teaching_activities (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Optional association pointer only; never part of identity PK (ADR D1)
  course_id UUID NULL REFERENCES courses(id) ON DELETE SET NULL,
  status TEXT NOT NULL
    CHECK (status IN ('active', 'paused', 'completed', 'skipped')),
  generate_status TEXT NOT NULL DEFAULT 'ready'
    CHECK (generate_status IN (
      'queued', 'generating', 'needs_check', 'ready',
      'failed', 'unknown', 'cancelled', 'stale'
    )),
  intent_kind TEXT NOT NULL
    CHECK (intent_kind IN (
      'material', 'topic', 'question', 'goal', 'resume', 'course_continue'
    )),
  intent_summary TEXT NOT NULL
    CHECK (char_length(intent_summary) BETWEEN 1 AND 2000),
  source_ids UUID[] NOT NULL DEFAULT '{}',
  goal_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  path_version INTEGER NOT NULL DEFAULT 1 CHECK (path_version > 0),
  content_version INTEGER NOT NULL DEFAULT 0 CHECK (content_version >= 0),
  checkpoint_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  client_key TEXT NOT NULL
    CHECK (char_length(client_key) BETWEEN 8 AND 200),
  create_intent JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, owner_user_id, client_key)
);

CREATE INDEX opening_teaching_activities_owner_status_idx
  ON opening_teaching_activities (workspace_id, owner_user_id, status, updated_at DESC);

CREATE INDEX opening_teaching_activities_course_idx
  ON opening_teaching_activities (workspace_id, course_id)
  WHERE course_id IS NOT NULL;

-- Option A: activity-scoped history counter; course counter table stays untouched.
CREATE TABLE opening_learning_activity_history_revisions (
  workspace_id UUID NOT NULL,
  owner_user_id UUID NOT NULL,
  activity_id UUID NOT NULL
    REFERENCES opening_teaching_activities(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL DEFAULT 0
    CHECK (revision BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (workspace_id, owner_user_id, activity_id)
);

-- A2 sequencing: nullable activity_id first, then backfill, then SET NOT NULL.
ALTER TABLE opening_learning_sessions
  ADD COLUMN activity_id UUID NULL;
ALTER TABLE opening_learning_observations
  ADD COLUMN activity_id UUID NULL;
ALTER TABLE opening_learning_attempts
  ADD COLUMN activity_id UUID NULL;
ALTER TABLE opening_learning_item_versions
  ADD COLUMN activity_id UUID NULL;

-- A1: one user-owned synthetic course_continue activity per distinct learning footprint.
INSERT INTO opening_teaching_activities (
  id, workspace_id, owner_user_id, course_id, status, generate_status,
  intent_kind, intent_summary, source_ids, goal_json, path_version, content_version,
  checkpoint_json, client_key, create_intent, created_at, updated_at
)
SELECT
  gen_random_uuid(),
  footprint.workspace_id,
  footprint.owner_user_id,
  footprint.course_id,
  'active',
  'ready',
  'course_continue',
  'Legacy course activity',
  '{}'::uuid[],
  '{}'::jsonb,
  1,
  0,
  '{}'::jsonb,
  'legacy-course-continue:' || footprint.course_id::text,
  jsonb_build_object(
    'intentKind', 'course_continue',
    'courseId', footprint.course_id,
    'legacy', true
  ),
  now(),
  now()
FROM (
  SELECT DISTINCT workspace_id, owner_user_id, course_id
  FROM opening_learning_sessions
  WHERE course_id IS NOT NULL
  UNION
  SELECT DISTINCT workspace_id, owner_user_id, course_id
  FROM opening_learning_observations
  WHERE course_id IS NOT NULL
) AS footprint;

UPDATE opening_learning_sessions s
SET activity_id = a.id
FROM opening_teaching_activities a
WHERE a.workspace_id = s.workspace_id
  AND a.owner_user_id = s.owner_user_id
  AND a.course_id = s.course_id
  AND a.client_key = 'legacy-course-continue:' || s.course_id::text
  AND s.activity_id IS NULL;

UPDATE opening_learning_observations o
SET activity_id = a.id
FROM opening_teaching_activities a
WHERE a.workspace_id = o.workspace_id
  AND a.owner_user_id = o.owner_user_id
  AND a.course_id = o.course_id
  AND a.client_key = 'legacy-course-continue:' || o.course_id::text
  AND o.activity_id IS NULL;

UPDATE opening_learning_attempts t
SET activity_id = a.id
FROM opening_teaching_activities a
WHERE a.workspace_id = t.workspace_id
  AND a.owner_user_id = t.owner_user_id
  AND a.course_id = t.course_id
  AND a.client_key = 'legacy-course-continue:' || t.course_id::text
  AND t.activity_id IS NULL;

UPDATE opening_learning_item_versions v
SET activity_id = a.id
FROM opening_teaching_activities a
WHERE a.workspace_id = v.workspace_id
  AND a.owner_user_id = v.owner_user_id
  AND a.course_id = v.course_id
  AND a.client_key = 'legacy-course-continue:' || v.course_id::text
  AND v.activity_id IS NULL;

ALTER TABLE opening_learning_sessions
  ALTER COLUMN activity_id SET NOT NULL;
ALTER TABLE opening_learning_observations
  ALTER COLUMN activity_id SET NOT NULL;
ALTER TABLE opening_learning_attempts
  ALTER COLUMN activity_id SET NOT NULL;
ALTER TABLE opening_learning_item_versions
  ALTER COLUMN activity_id SET NOT NULL;

ALTER TABLE opening_learning_sessions
  ADD CONSTRAINT opening_learning_sessions_activity_id_fkey
  FOREIGN KEY (activity_id) REFERENCES opening_teaching_activities(id);
ALTER TABLE opening_learning_observations
  ADD CONSTRAINT opening_learning_observations_activity_id_fkey
  FOREIGN KEY (activity_id) REFERENCES opening_teaching_activities(id);
ALTER TABLE opening_learning_attempts
  ADD CONSTRAINT opening_learning_attempts_activity_id_fkey
  FOREIGN KEY (activity_id) REFERENCES opening_teaching_activities(id);
ALTER TABLE opening_learning_item_versions
  ADD CONSTRAINT opening_learning_item_versions_activity_id_fkey
  FOREIGN KEY (activity_id) REFERENCES opening_teaching_activities(id);

ALTER TABLE opening_learning_sessions
  ALTER COLUMN course_id DROP NOT NULL;
ALTER TABLE opening_learning_observations
  ALTER COLUMN course_id DROP NOT NULL;
ALTER TABLE opening_learning_attempts
  ALTER COLUMN course_id DROP NOT NULL;
ALTER TABLE opening_learning_item_versions
  ALTER COLUMN course_id DROP NOT NULL;

CREATE INDEX opening_learning_sessions_workspace_activity_idx
  ON opening_learning_sessions (workspace_id, activity_id);
CREATE INDEX opening_learning_observations_workspace_activity_idx
  ON opening_learning_observations (workspace_id, activity_id);
CREATE INDEX opening_learning_attempts_workspace_activity_idx
  ON opening_learning_attempts (workspace_id, activity_id);
CREATE INDEX opening_learning_item_versions_workspace_activity_idx
  ON opening_learning_item_versions (workspace_id, activity_id);

-- Rollback notes (manual; do not DROP user data in product rollback):
-- 1. Feature-flag off new activity entry; retain rows.
-- 2. Reverse NOT NULL / nullable course_id only after clearing null course facts.
-- 3. DROP INDEX …_workspace_activity_idx; DROP CONSTRAINT …_activity_id_fkey;
-- 4. ALTER … DROP COLUMN activity_id on sessions/observations/attempts/item_versions;
-- 5. DROP TABLE opening_learning_activity_history_revisions;
-- 6. DROP TABLE opening_teaching_activities;
