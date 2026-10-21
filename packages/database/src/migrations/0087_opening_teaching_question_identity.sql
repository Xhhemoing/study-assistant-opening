-- Classroom questions refer to an append-only library revision, never a fabricated material.
-- These logical references survive history-only imports; reads require the actual owned revision/block.
ALTER TABLE opening_problem_refs
  ADD COLUMN teaching_revision_id uuid,
  ADD COLUMN teaching_block_id uuid,
  ALTER COLUMN source_id DROP NOT NULL,
  ALTER COLUMN source_version DROP NOT NULL,
  ADD CONSTRAINT opening_problem_refs_origin CHECK (
    (source_id IS NULL) = (source_version IS NULL)
    AND (teaching_revision_id IS NULL) = (teaching_block_id IS NULL)
    AND (source_id IS NOT NULL OR teaching_revision_id IS NOT NULL)
    AND (source_id IS NOT NULL OR (physical_page IS NULL AND chunk_id IS NULL))
  );
ALTER TABLE opening_learning_item_versions
  ADD COLUMN teaching_revision_id uuid,
  ADD COLUMN teaching_block_id uuid,
  ALTER COLUMN source_id DROP NOT NULL,
  ALTER COLUMN source_version DROP NOT NULL,
  ADD CONSTRAINT opening_learning_item_versions_origin CHECK (
    (source_id IS NULL) = (source_version IS NULL)
    AND (teaching_revision_id IS NULL) = (teaching_block_id IS NULL)
    AND (source_id IS NOT NULL OR teaching_revision_id IS NOT NULL)
    AND (source_id IS NOT NULL OR (physical_page IS NULL AND chunk_id IS NULL))
  );
