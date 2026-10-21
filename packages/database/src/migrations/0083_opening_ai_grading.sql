-- AI grades append revisions to the original answer. Old application readers do
-- not understand ai_graded: stop grading before rollback and retain this schema
-- and the compatible reader, or explicitly downgrade imported scoring authority.
ALTER TABLE opening_learning_observations ADD COLUMN ai_evaluation jsonb;
ALTER TABLE opening_learning_observations DROP CONSTRAINT opening_learning_observations_verdict_source_check;
ALTER TABLE opening_learning_observations ADD CONSTRAINT opening_learning_observations_verdict_source_check
  CHECK (verdict_source IN ('self_report', 'reference_checked', 'model_suggestion', 'unknown', 'deterministic', 'ai_graded'));
ALTER TABLE opening_learning_observations ADD CONSTRAINT opening_learning_ai_evaluation_object
  CHECK (ai_evaluation IS NULL OR jsonb_typeof(ai_evaluation) = 'object');
