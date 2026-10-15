-- E4: server-captured lineage for cards derived from submitted observations/linked notes.
-- Existing manual cards remain independent. HTTP callers cannot set source_ids directly.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS source_ids uuid[] NOT NULL DEFAULT '{}';
-- Rollback: removes source exclusion/deletion protection from derived cards; export/delete
-- derived cards before rollback, and roll back the matching application code together.
-- ALTER TABLE cards DROP COLUMN source_ids;
