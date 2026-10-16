-- Nullable additions preserve historical attempts. Retain facts during rollback.
-- Old readers do not accept deterministic verdict_source: keep a compatible reader
-- or explicitly back up/downgrade verdicts and invalidate eligibility before reverting.
ALTER TABLE opening_learning_item_versions ADD COLUMN evaluation_spec jsonb;
ALTER TABLE opening_learning_observations ADD COLUMN server_evaluation jsonb;
ALTER TABLE opening_learning_observations DROP CONSTRAINT opening_learning_observations_verdict_source_check;
ALTER TABLE opening_learning_observations ADD CONSTRAINT opening_learning_observations_verdict_source_check
  CHECK (verdict_source IN ('self_report', 'reference_checked', 'model_suggestion', 'unknown', 'deterministic'));
ALTER TABLE opening_learning_item_versions ADD CONSTRAINT opening_learning_item_evaluation_object
  CHECK (evaluation_spec IS NULL OR jsonb_typeof(evaluation_spec) = 'object');
ALTER TABLE opening_learning_observations ADD CONSTRAINT opening_learning_server_evaluation_object
  CHECK (server_evaluation IS NULL OR jsonb_typeof(server_evaluation) = 'object');
