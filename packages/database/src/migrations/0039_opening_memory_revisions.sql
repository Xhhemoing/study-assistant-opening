-- 0039_opening_memory_revisions.sql
-- M01: retain superseded confirmed memories as content-bearing revision history.
ALTER TABLE opening_memories
  DROP CONSTRAINT IF EXISTS opening_memories_status_check;
ALTER TABLE opening_memories
  ADD CONSTRAINT opening_memories_status_check
  CHECK (status IN ('active', 'rejected', 'deleted', 'superseded'));
