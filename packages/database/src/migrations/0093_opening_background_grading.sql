-- OPT06: immutable answer revisions and durable background assessment.
ALTER TABLE opening_jobs DROP CONSTRAINT IF EXISTS opening_jobs_kind_check;
ALTER TABLE opening_jobs ADD CONSTRAINT opening_jobs_kind_check CHECK (kind IN (
  'parse','tutor','retest','remind','build-course-knowledge','parse-media',
  'extract-study-actions','compile-teaching-unit','index-source','tutor-metadata',
  'recognize-photo-question','grade-observation'
));
ALTER TABLE opening_learning_observations
  ADD COLUMN answer_revision integer NOT NULL DEFAULT 1 CHECK (answer_revision > 0),
  ADD COLUMN grading_work_source jsonb CHECK (grading_work_source IS NULL OR jsonb_typeof(grading_work_source)='object'),
  ADD COLUMN grading_operation_id text;
-- Follow 0083's immutable chain, not timestamps or course-local history revisions.
WITH RECURSIVE chain AS (
  SELECT id,1 AS revision FROM opening_learning_observations WHERE COALESCE(root_observation_id,id)=id
  UNION ALL
  SELECT o.id,c.revision + CASE WHEN o.ai_evaluation IS NULL THEN 1 ELSE 0 END
  FROM opening_learning_observations o JOIN chain c ON o.revises_observation_id=c.id
)
UPDATE opening_learning_observations o SET answer_revision=c.revision,
  grading_work_source=o.ai_evaluation->'workSource',
  grading_operation_id='ai-grade:' || o.workspace_id::text || ':' || COALESCE(o.submitted_intent->'aiGrading'->'input'->>'observationId',o.id::text)
FROM chain c WHERE o.id=c.id;
-- Preserve already bound student photos across corrections, without mistaking
-- problem/reference materials for student work.
WITH RECURSIVE photos AS (
  SELECT id,grading_work_source AS photo FROM opening_learning_observations WHERE COALESCE(root_observation_id,id)=id
  UNION ALL
  SELECT o.id,COALESCE(o.grading_work_source,p.photo) FROM opening_learning_observations o JOIN photos p ON o.revises_observation_id=p.id
)
UPDATE opening_learning_observations o SET grading_work_source=p.photo FROM photos p WHERE p.id=o.id AND p.photo IS NOT NULL;

-- Rollback (preserve DDL, answers, evaluations, outbox and ledger): stop Web
-- submission/revision/enqueue writers and all grade-observation consumers FIRST.
-- Then fence unfinished jobs while holding the same workspace -> job lock order:
-- BEGIN;
-- SELECT id FROM workspaces ORDER BY id FOR UPDATE;
-- UPDATE opening_jobs SET state=CASE WHEN state='running' THEN 'outcome_unknown' ELSE 'cancelled' END,
--   claim_token=NULL,updated_at=now(),result='{"error":"background grading stopped for rollback"}'::jsonb
--   WHERE kind='grade-observation' AND state IN ('queued','running');
-- COMMIT;
-- Deploy a compatible reader (including 0083 ai_graded); do not drop these columns
-- or narrow the kind CHECK while grade jobs exist. Do not requeue unknown jobs,
-- refund reservations, or delete learning history. New-job entry remains stopped
-- until compatible writers/consumers are restored. Reconcile spend from ledger.
