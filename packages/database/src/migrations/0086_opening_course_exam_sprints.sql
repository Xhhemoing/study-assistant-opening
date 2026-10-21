-- Course exam preparation is independent for each course. Existing Math I
-- records remain the one legacy (NULL course) sprint and keep their receipts.
ALTER TABLE opening_exam_sprints ADD COLUMN course_id uuid REFERENCES courses(id) ON DELETE CASCADE;
ALTER TABLE opening_exam_sprints DROP CONSTRAINT opening_exam_sprint_scope_unique;
CREATE UNIQUE INDEX opening_exam_sprint_legacy_scope_unique
  ON opening_exam_sprints(workspace_id,owner_user_id) WHERE course_id IS NULL;
CREATE UNIQUE INDEX opening_exam_sprint_course_scope_unique
  ON opening_exam_sprints(workspace_id,owner_user_id,course_id) WHERE course_id IS NOT NULL;

-- Apply before the application. Revert only to a compatible application that
-- retains course_id IS NULL on legacy readers, after stopping course exam
-- writes. Older unfiltered readers cannot parse the retained course snapshots.
-- Retain this additive column, both indexes and all records.
-- Do not restore the old scope-wide unique constraint while course rows exist.
