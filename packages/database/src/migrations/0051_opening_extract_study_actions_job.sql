-- P04: allow extract-study-actions jobs for multi-source action digest candidates.
ALTER TABLE opening_jobs DROP CONSTRAINT IF EXISTS opening_jobs_kind_check;
ALTER TABLE opening_jobs
  ADD CONSTRAINT opening_jobs_kind_check
  CHECK (kind IN (
    'parse','tutor','retest','remind','build-course-knowledge','parse-media','extract-study-actions'
  ));

-- Rollback:
-- ALTER TABLE opening_jobs DROP CONSTRAINT IF EXISTS opening_jobs_kind_check;
-- ALTER TABLE opening_jobs ADD CONSTRAINT opening_jobs_kind_check
--   CHECK (kind IN ('parse','tutor','retest','remind','build-course-knowledge','parse-media'));
