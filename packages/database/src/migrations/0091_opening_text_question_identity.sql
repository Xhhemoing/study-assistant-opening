-- A pasted question is sealed by its problem/item version and owning session.
-- No fabricated material or teaching revision is needed. Retain paired origins
-- and prevent material locations on questions with no material source.
ALTER TABLE opening_problem_refs DROP CONSTRAINT opening_problem_refs_origin;
ALTER TABLE opening_problem_refs ADD CONSTRAINT opening_problem_refs_origin CHECK (
  (source_id IS NULL) = (source_version IS NULL)
  AND (teaching_revision_id IS NULL) = (teaching_block_id IS NULL)
  AND (source_id IS NOT NULL OR (physical_page IS NULL AND chunk_id IS NULL))
);
ALTER TABLE opening_learning_item_versions DROP CONSTRAINT opening_learning_item_versions_origin;
ALTER TABLE opening_learning_item_versions ADD CONSTRAINT opening_learning_item_versions_origin CHECK (
  (source_id IS NULL) = (source_version IS NULL)
  AND (teaching_revision_id IS NULL) = (teaching_block_id IS NULL)
  AND (source_id IS NOT NULL OR (physical_page IS NULL AND chunk_id IS NULL))
);
-- Rollback: stop new text-question writes and retain these compatible constraints
-- and saved questions. Reinstating the old constraints requires explicitly moving
-- existing text-question records first; never delete learner history to downgrade.
