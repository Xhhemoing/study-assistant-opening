-- Photo transcription uses the durable job/outbox and budget execution claim.
ALTER TABLE opening_jobs DROP CONSTRAINT IF EXISTS opening_jobs_kind_check;
ALTER TABLE opening_jobs ADD CONSTRAINT opening_jobs_kind_check CHECK (kind IN (
  'parse','tutor','retest','remind','build-course-knowledge','parse-media',
  'extract-study-actions','compile-teaching-unit','index-source','tutor-metadata',
  'recognize-photo-question'
));

-- Rollback: stop recognition writers/consumers and resolve unfinished jobs
-- before returning to compatible code. Keep this CHECK and saved results by
-- default. Restore the previous CHECK only after a separately audited archive
-- confirms no recognize-photo-question rows remain. Never reset unknown jobs
-- to queued or delete saved learning results as part of an ordinary rollback.
