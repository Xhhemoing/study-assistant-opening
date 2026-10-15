-- Course study plans: the lesson (or review) a planner-made task stands for.
-- Additive: NULL for every existing and hand-made task. Plan settings live in
-- workspace_preferences.adaptive_planning.courseGoals[courseId].studyPlan (0061).
-- Shape (server-written only): {"v":1,"kind":"lesson"|"review","localDate":"YYYY-MM-DD",
--   "lessonIndexes":[int],"chunkIds":[uuid],"note"?:text}
ALTER TABLE opening_tasks
  ADD COLUMN IF NOT EXISTS plan_slot jsonb NULL
    CHECK (plan_slot IS NULL OR jsonb_typeof(plan_slot) = 'object');

CREATE INDEX IF NOT EXISTS opening_tasks_course_plan_idx
  ON opening_tasks (workspace_id, owner_user_id, course_id)
  WHERE plan_slot IS NOT NULL;

-- Rollback (plan tasks become ordinary course tasks; nothing else depends on it):
-- DROP INDEX IF EXISTS opening_tasks_course_plan_idx;
-- ALTER TABLE opening_tasks DROP COLUMN IF EXISTS plan_slot;
