CREATE TABLE opening_retest_activities (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  skill_label TEXT NOT NULL CHECK (char_length(skill_label) BETWEEN 1 AND 200),
  requirement_key TEXT NULL CHECK (requirement_key IS NULL OR char_length(requirement_key) BETWEEN 1 AND 200),
  purpose TEXT NOT NULL DEFAULT 'retest' CHECK (purpose = 'retest'),
  evidence_cycle_id UUID NOT NULL,
  candidate_id UUID NULL REFERENCES opening_jobs(id) ON DELETE SET NULL,
  task_id UUID NULL REFERENCES opening_tasks(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','accepted','in_progress','completed','declined','cancelled','invalidated','superseded')),
  result TEXT NULL CHECK (result IS NULL OR result IN ('correct','incorrect','unverified')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  snoozed_until TIMESTAMPTZ NULL,
  proposed_at TIMESTAMPTZ NULL,
  accepted_at TIMESTAMPTZ NULL,
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  declined_at TIMESTAMPTZ NULL,
  cancelled_at TIMESTAMPTZ NULL,
  invalidated_at TIMESTAMPTZ NULL,
  superseded_at TIMESTAMPTZ NULL,
  not_before_at TIMESTAMPTZ NULL,
  recommended_at TIMESTAMPTZ NULL,
  scheduled_start_at TIMESTAMPTZ NULL,
  deadline_at TIMESTAMPTZ NULL,
  reason TEXT NULL CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 200),
  reopened_from_activity_id UUID NULL REFERENCES opening_retest_activities(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX opening_retest_activity_cycle_key
  ON opening_retest_activities (workspace_id, owner_user_id, course_id, skill_label,
    COALESCE(requirement_key, ''), purpose, evidence_cycle_id);
CREATE UNIQUE INDEX opening_retest_activity_candidate_key
  ON opening_retest_activities (workspace_id, candidate_id)
  WHERE candidate_id IS NOT NULL;
CREATE UNIQUE INDEX opening_retest_activity_task_key
  ON opening_retest_activities (workspace_id, task_id)
  WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX opening_retest_activity_active_business_key
  ON opening_retest_activities (workspace_id, owner_user_id, course_id, skill_label,
    COALESCE(requirement_key, ''), purpose)
  WHERE status IN ('proposed', 'accepted', 'in_progress');
CREATE INDEX opening_retest_activity_due_idx
  ON opening_retest_activities (workspace_id, owner_user_id, course_id, status, recommended_at);

-- Preserve the business meaning of legacy retest jobs without restoring transport jobs.
-- The job UUID is the stable activity identity. Rows with an unresolvable course
-- or skill stay in the job payload for manual reconciliation; unresolved task
-- links are represented on the activity and never auto-enqueued.
WITH legacy AS (
  SELECT
    j.id AS candidate_id, j.workspace_id, j.owner_user_id, c.id AS course_id,
    left(j.payload->>'skillLabel', 200) AS skill_label,
    CASE WHEN j.payload->>'requirementKey' IS NULL OR char_length(j.payload->>'requirementKey') BETWEEN 1 AND 200
      THEN NULLIF(j.payload->>'requirementKey', '') ELSE NULL END AS requirement_key,
    j.payload, j.created_at, j.updated_at, t.id AS task_id, t.status AS task_status,
    t.updated_at AS task_updated_at, o.outcome,
    CASE WHEN j.payload->>'cycleId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN (j.payload->>'cycleId')::uuid ELSE j.id END AS source_cycle_id,
    row_number() OVER (
      PARTITION BY j.workspace_id, j.owner_user_id, c.id, left(j.payload->>'skillLabel', 200),
        COALESCE(CASE WHEN j.payload->>'requirementKey' IS NULL OR char_length(j.payload->>'requirementKey') BETWEEN 1 AND 200
          THEN NULLIF(j.payload->>'requirementKey', '') ELSE NULL END, '')
      ORDER BY CASE
        WHEN t.status = 'done' THEN 0
        WHEN t.status = 'skipped' THEN 1
        WHEN j.payload->>'accepted' = 'true' THEN 2
        WHEN j.payload->>'discarded' = 'true' THEN 3
        ELSE 4
      END, j.created_at, j.id
    ) AS business_rank
  FROM opening_jobs j
  JOIN courses c ON lower(c.id::text) = lower(j.payload->>'courseId') AND c.workspace_id = j.workspace_id
  LEFT JOIN opening_tasks t ON lower(t.id::text) = lower(j.payload->>'taskId')
    AND t.workspace_id = j.workspace_id AND t.owner_user_id = j.owner_user_id
    AND t.candidate_id = j.id
  LEFT JOIN LATERAL (
    SELECT outcome FROM opening_learning_observations
    WHERE workspace_id = j.workspace_id AND owner_user_id = j.owner_user_id AND retest_id = j.id
    ORDER BY occurred_at DESC, id DESC LIMIT 1
  ) o ON true
  WHERE j.kind = 'retest' AND j.payload->>'skillLabel' IS NOT NULL
    AND char_length(j.payload->>'skillLabel') BETWEEN 1 AND 200
)
INSERT INTO opening_retest_activities (
  id, workspace_id, owner_user_id, course_id, skill_label, requirement_key, purpose, evidence_cycle_id,
  candidate_id, task_id, status, result, version, proposed_at, accepted_at, completed_at, cancelled_at,
  not_before_at, recommended_at, scheduled_start_at, deadline_at, reason
)
SELECT
  candidate_id, workspace_id, owner_user_id, course_id, skill_label, requirement_key, 'retest',
  CASE WHEN business_rank = 1 THEN source_cycle_id
    ELSE md5(candidate_id::text || ':legacy-duplicate-cycle')::uuid END,
  candidate_id, CASE WHEN business_rank = 1 THEN task_id ELSE NULL END,
  CASE
    WHEN business_rank > 1 THEN 'superseded'
    WHEN task_status = 'done' THEN 'completed'
    WHEN task_status = 'skipped' THEN 'cancelled'
    WHEN payload->>'discarded' = 'true' THEN 'declined'
    WHEN payload->>'accepted' = 'true' AND task_id IS NOT NULL THEN 'accepted'
    ELSE 'proposed'
  END,
  CASE WHEN outcome IN ('correct', 'incorrect', 'unverified') THEN outcome
    WHEN task_status = 'done' THEN 'unverified' ELSE NULL END,
  CASE
    WHEN business_rank > 1 OR task_status = 'done' THEN 3
    WHEN payload->>'accepted' = 'true' THEN 2 ELSE 1
  END,
  created_at,
  CASE WHEN payload->>'accepted' = 'true' THEN
    CASE WHEN pg_input_is_valid(payload->>'acceptedAt', 'timestamptz')
      THEN (payload->>'acceptedAt')::timestamptz ELSE updated_at END
    ELSE NULL END,
  CASE WHEN business_rank = 1 AND task_status = 'done' THEN task_updated_at ELSE NULL END,
  CASE WHEN business_rank = 1 AND task_status = 'skipped' THEN task_updated_at ELSE NULL END,
  CASE WHEN business_rank = 1 AND pg_input_is_valid(payload->>'notBeforeAt', 'timestamptz')
    THEN (payload->>'notBeforeAt')::timestamptz ELSE NULL END,
  CASE WHEN business_rank = 1 AND payload->>'accepted' = 'true' AND task_id IS NULL THEN NULL
    WHEN business_rank = 1 AND pg_input_is_valid(payload->>'dueAt', 'timestamptz')
      THEN (payload->>'dueAt')::timestamptz ELSE NULL END,
  CASE WHEN business_rank = 1 AND payload->>'accepted' = 'true' AND task_id IS NULL THEN NULL
    WHEN business_rank = 1 AND pg_input_is_valid(payload->>'scheduledStartAt', 'timestamptz')
      THEN (payload->>'scheduledStartAt')::timestamptz ELSE NULL END,
  CASE WHEN business_rank = 1 AND pg_input_is_valid(payload->>'deadlineAt', 'timestamptz')
    THEN (payload->>'deadlineAt')::timestamptz ELSE NULL END,
  NULLIF(left(concat_ws(';',
    CASE WHEN business_rank > 1 THEN 'legacy_duplicate_unresolved' END,
    CASE WHEN payload->>'accepted' = 'true' AND task_id IS NULL THEN 'legacy_task_unresolved' END,
    CASE WHEN payload->>'accepted' <> 'true' AND task_id IS NOT NULL THEN 'legacy_acceptance_unresolved' END,
    CASE WHEN char_length(payload->>'requirementKey') > 200 THEN 'legacy_requirement_unresolved' END,
    CASE WHEN payload->>'discarded' = 'true' THEN 'legacy_discarded' END
  ), 200), '')
FROM legacy;

-- Keep candidates that cannot be represented as an activity visible for manual
-- reconciliation. They remain transport history and are never re-enqueued.
UPDATE opening_jobs j
SET payload = CASE WHEN jsonb_typeof(j.payload) = 'object'
  THEN j.payload || jsonb_build_object(
    'retestActivityMigration', jsonb_build_object('status', 'needs_review', 'reason',
      CASE WHEN NOT EXISTS (
        SELECT 1 FROM courses c WHERE lower(c.id::text) = lower(j.payload->>'courseId') AND c.workspace_id = j.workspace_id
      ) THEN 'course_unresolved'
      WHEN j.payload->>'skillLabel' IS NULL OR char_length(j.payload->>'skillLabel') NOT BETWEEN 1 AND 200
        THEN 'skill_unresolved'
      ELSE 'duplicate_or_unresolved' END))
  ELSE jsonb_build_object('legacyPayload', j.payload,
    'retestActivityMigration', jsonb_build_object('status', 'needs_review', 'reason', 'payload_unresolved')) END,
  updated_at = now()
WHERE j.kind = 'retest'
  AND NOT EXISTS (
    SELECT 1 FROM opening_retest_activities a
    WHERE a.workspace_id = j.workspace_id AND a.owner_user_id = j.owner_user_id AND a.candidate_id = j.id
  );
