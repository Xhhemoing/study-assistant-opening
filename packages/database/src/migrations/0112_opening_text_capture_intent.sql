-- NULL identifies ordinary uploads and older captures whose original course is unknown.
ALTER TABLE opening_sources ADD COLUMN text_capture_intent jsonb;

-- Rollback with capture writes stopped: ALTER TABLE opening_sources DROP COLUMN text_capture_intent;
-- Removing the column discards course bindings. Keep it through application rollback.
