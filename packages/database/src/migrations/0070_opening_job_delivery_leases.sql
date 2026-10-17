-- Running jobs are never taken over: an expired execution has an unknown
-- outcome and must be reconciled before a new user-authorized execution.
ALTER TABLE opening_jobs ADD COLUMN claim_token uuid;
ALTER TABLE opening_tutor_jobs ADD COLUMN claim_token uuid;
ALTER TABLE opening_tutor_jobs ADD COLUMN dispatch_after timestamptz NOT NULL DEFAULT now();

-- A dispatch lease is separate from the delivery state. Redis network I/O
-- happens after this short claim transaction commits.
ALTER TABLE opening_outbox ADD COLUMN dispatch_token uuid;
ALTER TABLE opening_outbox ADD COLUMN lease_until timestamptz;
ALTER TABLE opening_outbox ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0);
ALTER TABLE opening_outbox ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE opening_outbox ADD COLUMN last_error text;

CREATE INDEX opening_outbox_dispatch_due_idx ON opening_outbox(next_attempt_at, created_at)
  WHERE state IN ('pending', 'failed');
CREATE INDEX opening_outbox_job_idx ON opening_outbox(job_id);
CREATE INDEX opening_jobs_running_updated_idx ON opening_jobs(updated_at) WHERE state = 'running';
CREATE INDEX opening_jobs_active_source_idx ON opening_jobs((payload->>'sourceId'))
  WHERE state = 'running' AND kind IN ('parse', 'parse-media');
CREATE INDEX opening_tutor_jobs_queued_idx ON opening_tutor_jobs(dispatch_after, created_at) WHERE status = 'queued';
CREATE INDEX opening_tutor_jobs_running_updated_idx ON opening_tutor_jobs(updated_at) WHERE status = 'running';
CREATE INDEX opening_tutor_jobs_conversation_idx ON opening_tutor_jobs(conversation_id, created_at DESC, id DESC);
CREATE INDEX opening_tutor_jobs_user_turn_idx ON opening_tutor_jobs(user_turn_id);
CREATE INDEX opening_tutor_jobs_assistant_turn_idx ON opening_tutor_jobs(assistant_turn_id);

-- Rollback: first stop the new workers. Drop the indexes and the added columns.
-- Terminal outcomes already recorded by recovery remain terminal; never reset
-- them to queued because the external effect may already have happened.
/*
DROP INDEX opening_outbox_dispatch_due_idx, opening_outbox_job_idx,
  opening_jobs_running_updated_idx, opening_jobs_active_source_idx,
  opening_tutor_jobs_queued_idx, opening_tutor_jobs_running_updated_idx,
  opening_tutor_jobs_conversation_idx, opening_tutor_jobs_user_turn_idx,
  opening_tutor_jobs_assistant_turn_idx;
ALTER TABLE opening_outbox DROP COLUMN dispatch_token, DROP COLUMN lease_until,
  DROP COLUMN attempts, DROP COLUMN next_attempt_at, DROP COLUMN last_error;
ALTER TABLE opening_jobs DROP COLUMN claim_token;
ALTER TABLE opening_tutor_jobs DROP COLUMN claim_token, DROP COLUMN dispatch_after;
*/
