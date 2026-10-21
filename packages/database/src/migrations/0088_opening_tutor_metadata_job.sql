-- Optional suggestions use the existing durable job/outbox lifecycle, outside tutor capacity.
ALTER TABLE opening_jobs DROP CONSTRAINT IF EXISTS opening_jobs_kind_check;
ALTER TABLE opening_jobs ADD CONSTRAINT opening_jobs_kind_check CHECK (kind IN (
  'parse','tutor','retest','remind','build-course-knowledge','parse-media',
  'extract-study-actions','compile-teaching-unit','index-source','tutor-metadata'
));

-- Rollback after stopping writers: delete tutor-metadata jobs (outbox cascades),
-- then restore the previous CHECK without tutor-metadata. Completed answers remain intact.
