-- V2-07: allow compile-teaching-unit jobs for teaching generation / repair.
ALTER TABLE opening_jobs DROP CONSTRAINT IF EXISTS opening_jobs_kind_check;
ALTER TABLE opening_jobs
  ADD CONSTRAINT opening_jobs_kind_check
  CHECK (kind IN (
    'parse','tutor','retest','remind','build-course-knowledge','parse-media','extract-study-actions','compile-teaching-unit'
  ));

-- Rollback:
-- ALTER TABLE opening_jobs DROP CONSTRAINT IF EXISTS opening_jobs_kind_check;
-- ALTER TABLE opening_jobs ADD CONSTRAINT opening_jobs_kind_check
--   CHECK (kind IN ('parse','tutor','retest','remind','build-course-knowledge','parse-media','extract-study-actions'));
