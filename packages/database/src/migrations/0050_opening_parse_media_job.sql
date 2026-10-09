-- V01: allow parse-media jobs for audio/video transcription alignment.
ALTER TABLE opening_jobs DROP CONSTRAINT IF EXISTS opening_jobs_kind_check;
ALTER TABLE opening_jobs
  ADD CONSTRAINT opening_jobs_kind_check
  CHECK (kind IN ('parse','tutor','retest','remind','build-course-knowledge','parse-media'));

-- Rollback:
-- ALTER TABLE opening_jobs DROP CONSTRAINT IF EXISTS opening_jobs_kind_check;
-- ALTER TABLE opening_jobs ADD CONSTRAINT opening_jobs_kind_check
--   CHECK (kind IN ('parse','tutor','retest','remind','build-course-knowledge'));
