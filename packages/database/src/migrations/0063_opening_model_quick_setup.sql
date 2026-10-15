-- Idempotency is scoped to one workspace. Existing providers are unaffected.
ALTER TABLE opening_model_providers ADD COLUMN quick_setup_key text;
CREATE UNIQUE INDEX opening_model_providers_quick_setup_key_idx
  ON opening_model_providers (workspace_id, quick_setup_key) WHERE quick_setup_key IS NOT NULL;
-- Rollback (after rolling back the application):
-- DROP INDEX opening_model_providers_quick_setup_key_idx;
-- ALTER TABLE opening_model_providers DROP COLUMN quick_setup_key;
