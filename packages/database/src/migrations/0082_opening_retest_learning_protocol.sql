-- Learning protocols and acceptance receipts are durable domain facts, not jobs.
-- Rollback: stop new learning writes before switching application versions. Keep
-- these additive columns and their data; old code cannot resume job-free restored
-- retests, so such workspaces require this version or a pre-upgrade backup.
ALTER TABLE opening_retest_activities
  ADD COLUMN learning_protocol JSONB,
  ADD COLUMN candidate_reference_id UUID,
  ADD COLUMN accept_client_key TEXT;

UPDATE opening_retest_activities SET candidate_reference_id=candidate_id
WHERE candidate_id IS NOT NULL;

UPDATE opening_retest_activities r SET
  learning_protocol=jsonb_build_object(
    'protocolId','span-delayed-3d-v1',
    'baselineObservationId',j.payload->'spanDelayedProtocol'->>'baselineObservationId',
    'baselineRootId',j.payload->'spanDelayedProtocol'->>'baselineRootId',
    'priorAnswerPolicy','require_unseen_problem'),
  accept_client_key=CASE WHEN r.task_id IS NOT NULL AND r.accepted_at IS NOT NULL
    AND j.payload->>'accepted'='true' THEN NULLIF(j.payload->>'acceptClientKey','') END
FROM opening_jobs j
WHERE j.id=r.candidate_id AND j.workspace_id=r.workspace_id AND j.owner_user_id=r.owner_user_id
  AND j.kind='retest' AND j.payload->'spanDelayedProtocol'->>'protocolId'='span-delayed-3d-v1'
  AND j.payload->'spanDelayedProtocol'->>'priorAnswerPolicy'='require_unseen_problem'
  AND EXISTS (SELECT 1 FROM opening_learning_observations b
    WHERE b.id::text=j.payload->'spanDelayedProtocol'->>'baselineObservationId'
      AND COALESCE(b.root_observation_id,b.id)::text=j.payload->'spanDelayedProtocol'->>'baselineRootId'
      AND b.workspace_id=r.workspace_id AND b.owner_user_id=r.owner_user_id AND b.course_id=r.course_id
      AND b.skill_label=r.skill_label AND b.requirement_key IS NOT DISTINCT FROM r.requirement_key);

CREATE UNIQUE INDEX opening_retest_candidate_reference_uidx
  ON opening_retest_activities(workspace_id,owner_user_id,candidate_reference_id)
  WHERE candidate_reference_id IS NOT NULL;
CREATE UNIQUE INDEX opening_retest_accept_client_key_uidx
  ON opening_retest_activities(workspace_id,owner_user_id,accept_client_key)
  WHERE accept_client_key IS NOT NULL;
ALTER TABLE opening_retest_activities ADD CONSTRAINT opening_retest_learning_protocol_object
  CHECK (learning_protocol IS NULL OR jsonb_typeof(learning_protocol)='object');
